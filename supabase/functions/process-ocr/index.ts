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
    const pageCount: number = body.pageCount

    console.log('[process-ocr] gestartet', { scanId, pageCount })

    if (!scanId || !pageCount) throw new Error('Missing required parameters: scanId, pageCount')

    await supabase.from('raw_scans')
      .update({ status: 'processing' })
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

    // ── Step 3: OCR all PNGs via Vision API (max 5 parallel) ─────────────────
    const pageFilenames = Array.from({ length: pageCount }, (_, i) =>
      `page_${String(i + 1).padStart(3, '0')}.png`
    )

    console.log('[process-ocr] OCR startet für', pageCount, 'Seiten…')

    const ocrTasks = pageFilenames.map((filename) => async () => {
      try {
        const text = await ocrPageWithVision(supabase, scanId!, filename, token)
        console.log(`[process-ocr] OCR OK: ${filename} → ${text.length} Zeichen`)
        return text
      } catch (err) {
        console.error(`[process-ocr] OCR FEHLER: ${filename}:`, (err as Error).message)
        return `[Seite nicht lesbar: ${filename}]`
      }
    })

    const pageTexts: string[] = await pLimit(ocrTasks, 5)

    // ── Step 4: Analyze each page with Claude Haiku (max 5 parallel) ─────────
    console.log('[process-ocr] Haiku-Analyse startet…')

    const analyzeTasks = pageTexts.map((text, i) => async () => {
      try {
        const result = await callFunction('analyze-page', {
          page: i + 1,
          text,
          fileName: originalFilename,
        }) as AnalyzedPage
        console.log(`[process-ocr] analyze-page OK: Seite ${i + 1} → ${result.topic_label}`)
        return result
      } catch (err) {
        console.error(`[process-ocr] analyze-page FEHLER Seite ${i + 1}:`, (err as Error).message)
        return {
          page: i + 1,
          topic_key: `page_${i + 1}`,
          topic_label: `Seite ${i + 1}`,
          topic_embedding_text: text.slice(0, 200),
          content_html: `<p>${text.slice(0, 500)}</p>`,
          key_concepts: [],
        } as AnalyzedPage
      }
    })

    const analyzedPages = (await pLimit(analyzeTasks, 5)) as AnalyzedPage[]

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
