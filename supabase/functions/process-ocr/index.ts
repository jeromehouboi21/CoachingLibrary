import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnalyzedPage {
  page: number
  topic_key: string
  topic_label: string
  topic_embedding_text: string
  content_html: string
  key_concepts: string[]
  embedding?: number[]
}

// ─── Google Vision API ────────────────────────────────────────────────────────

async function getGoogleAccessToken(clientEmail: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-vision',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }

  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  const signingInput = `${b64url(header)}.${b64url(payload)}`

  const pem = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  )

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  const jwt = `${signingInput}.${sigB64}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  const tokenData = await res.json()
  if (!tokenData.access_token) throw new Error(`Google auth failed: ${JSON.stringify(tokenData)}`)
  return tokenData.access_token
}

async function ocrPageWithVision(
  supabase: ReturnType<typeof createClient>,
  scanId: string,
  pageFilename: string,
  token: string
): Promise<string> {
  const { data, error } = await supabase.storage
    .from('raw-scans')
    .download(`${scanId}/${pageFilename}`)

  if (error) throw new Error(`Storage download failed for ${pageFilename}: ${error.message}`)

  const arrayBuffer = await data.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  const base64 = btoa(binary)

  const res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['de'] },
      }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Vision API error for ${pageFilename} (${res.status}): ${text}`)
  }

  const visionData = await res.json()
  return visionData.responses[0]?.fullTextAnnotation?.text ?? ''
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callFunction(name: string, body: unknown): Promise<unknown> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${name} failed (${res.status}): ${text}`)
  }
  return res.json()
}

async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = []
  let idx = 0

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  return results
}

/** Parse page number from filename like "page_003.png" → 3 */
function pageNumberFromFilename(filename: string): number {
  const match = filename.match(/page_(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let scanId: string | undefined

  try {
    const body = await req.json()
    scanId = body.scanId
    const pageFilenames: string[] = body.pageFilenames

    console.log('[process-ocr] gestartet', { scanId, pages: pageFilenames?.length })

    if (!scanId) throw new Error('Missing required parameter: scanId')
    if (!pageFilenames || pageFilenames.length === 0) throw new Error('pageFilenames fehlt im Request-Body')

    await supabase.from('raw_scans')
      .update({ status: 'processing', ocr_pages_done: 0 })
      .eq('id', scanId)

    // ── Step 1: Google Access Token ──────────────────────────────────────────
    const clientEmail = Deno.env.get('GOOGLE_CLIENT_EMAIL')
    const privateKey = Deno.env.get('GOOGLE_PRIVATE_KEY')?.replace(/\\n/g, '\n')
    if (!clientEmail) throw new Error('Secret GOOGLE_CLIENT_EMAIL fehlt')
    if (!privateKey) throw new Error('Secret GOOGLE_PRIVATE_KEY fehlt')

    const token = await getGoogleAccessToken(clientEmail, privateKey)
    console.log('[process-ocr] Access Token erhalten')

    // ── Step 2: Read originalFilename from meta.json ─────────────────────────
    let originalFilename = 'scan.pdf'
    try {
      const { data: metaBlob } = await supabase.storage
        .from('raw-scans')
        .download(`${scanId}/meta.json`)
      if (metaBlob) {
        const meta = JSON.parse(await metaBlob.text())
        if (meta.originalFilename) originalFilename = meta.originalFilename
      }
    } catch { /* non-critical */ }

    console.log('[process-ocr] OCR startet für', pageFilenames.length, 'Seiten…')

    // ── Step 3: OCR each page, write per-page status to page_hashes ──────────
    const ocrTasks = pageFilenames.map((filename) => async () => {
      const pageNumber = pageNumberFromFilename(filename)

      // Mark page as processing
      await supabase.from('page_hashes')
        .update({ status: 'processing' })
        .eq('scan_id', scanId!)
        .eq('page_number', pageNumber)

      try {
        const text = await ocrPageWithVision(supabase, scanId!, filename, token)
        console.log(`[process-ocr] OCR OK: ${filename} → ${text.length} Zeichen`)

        // Save OCR text and mark ocr_complete
        await supabase.from('page_hashes')
          .update({ status: 'ocr_complete', ocr_text: text })
          .eq('scan_id', scanId!)
          .eq('page_number', pageNumber)

        await supabase.rpc('increment_ocr_progress', { scan_id: scanId! })

        return text
      } catch (err) {
        const msg = (err as Error).message
        console.error(`[process-ocr] OCR FEHLER: ${filename}:`, msg)

        await supabase.from('page_hashes')
          .update({ status: 'error', error_message: msg })
          .eq('scan_id', scanId!)
          .eq('page_number', pageNumber)

        await supabase.rpc('increment_ocr_progress', { scan_id: scanId! })

        return `[Seite nicht lesbar: ${filename}]`
      }
    })

    const pageTexts: string[] = await pLimit(ocrTasks, 5)

    // ── Step 4: Analyze each page with Claude Haiku (max 5 parallel) ─────────
    console.log('[process-ocr] Haiku-Analyse startet…')

    const analyzeTasks = pageTexts.map((text, i) => async () => {
      const filename = pageFilenames[i]
      const pageNumber = pageNumberFromFilename(filename)

      try {
        const result = await callFunction('analyze-page', {
          page: i + 1,
          text,
          fileName: originalFilename,
        }) as AnalyzedPage
        console.log(`[process-ocr] analyze-page OK: Seite ${i + 1} → ${result.topic_label}`)

        // Save analysis JSONB to page_hashes
        await supabase.from('page_hashes')
          .update({ analysis: result })
          .eq('scan_id', scanId!)
          .eq('page_number', pageNumber)

        return result
      } catch (err) {
        const msg = (err as Error).message
        const isRateLimit = msg.includes('429') || msg.includes('rate_limit')

        const errorMessage = isRateLimit
          ? `Rate Limit erreicht – bitte erneut verarbeiten (${msg.slice(0, 100)})`
          : msg

        console.error(`[process-ocr] analyze-page FEHLER Seite ${i + 1}:`, errorMessage)

        await supabase.from('page_hashes')
          .update({ status: 'error', error_message: errorMessage })
          .eq('scan_id', scanId!)
          .eq('page_number', pageNumber)

        const fallback: AnalyzedPage = {
          page: i + 1,
          topic_key: `page_${i + 1}`,
          topic_label: `Seite ${i + 1}`,
          topic_embedding_text: text.slice(0, 200),
          content_html: `<p>${text.slice(0, 500)}</p>`,
          key_concepts: [],
        }

        return fallback
      }
    })

    const analyzedPages = (await pLimit(analyzeTasks, 3)) as AnalyzedPage[]

    console.log('[process-ocr] abgeschlossen:', analyzedPages.length, 'Seiten analysiert')

    // ── Step 5: Save results to DB for process-cluster to pick up ─────────────
    const { error: saveError } = await supabase.from('raw_scans').update({
      status: 'ocr_complete',
      ocr_results: analyzedPages,
    }).eq('id', scanId)

    if (saveError) throw saveError

    return new Response(
      JSON.stringify({ success: true, pageCount: analyzedPages.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('[process-ocr] FEHLER:', (error as Error).message)

    if (scanId) {
      const { error: updateError } = await supabase.from('raw_scans').update({
        status: 'error',
        error_message: (error as Error).message,
      }).eq('id', scanId)
      if (updateError) console.error('[process-ocr] Status-Update fehlgeschlagen:', updateError.message)
    }

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
