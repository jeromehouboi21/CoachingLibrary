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
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  )

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
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
  pageNumber: number,
  token: string
): Promise<string> {
  const filename = `page_${String(pageNumber).padStart(3, '0')}.png`
  const { data, error } = await supabase.storage
    .from('raw-scans')
    .download(`${scanId}/${filename}`)

  if (error) throw new Error(`Storage download failed for ${filename}: ${error.message}`)

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
    throw new Error(`Vision API error (${res.status}): ${text}`)
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

// Note: callFunction is only used for analyze-page (not process-cluster).
// process-cluster is triggered by the frontend via supabase.functions.invoke
// so it runs with the user JWT instead of the service role key.

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

  try {
    const body = await req.json()
    // scanId: reprocess a specific scan; omit to reprocess all failed pages across all scans
    const scanId: string | undefined = body.scanId

    console.log('[reprocess-pages] gestartet', { scanId: scanId ?? 'alle' })

    // ── Find pages to reprocess ───────────────────────────────────────────────
    let query = supabase
      .from('page_hashes')
      .select('id, scan_id, page_number, status')
      .in('status', ['error', 'uploaded', 'processing', 'ocr_complete'])
      .is('doc_id', null)

    if (scanId) {
      query = query.eq('scan_id', scanId)
    }

    const { data: pages, error: pagesError } = await query
    if (pagesError) throw pagesError

    if (!pages || pages.length === 0) {
      return new Response(
        JSON.stringify({ success: true, reprocessed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('[reprocess-pages]', pages.length, 'Seiten zu verarbeiten')

    // ── Google token ──────────────────────────────────────────────────────────
    const clientEmail = Deno.env.get('GOOGLE_CLIENT_EMAIL')
    const privateKey = Deno.env.get('GOOGLE_PRIVATE_KEY')?.replace(/\\n/g, '\n')
    if (!clientEmail) throw new Error('Secret GOOGLE_CLIENT_EMAIL fehlt')
    if (!privateKey) throw new Error('Secret GOOGLE_PRIVATE_KEY fehlt')

    const token = await getGoogleAccessToken(clientEmail, privateKey)

    // Group pages by scan_id to get originalFilename once per scan
    const scanIds = [...new Set(pages.map(p => p.scan_id))]
    const scanFilenames: Record<string, string> = {}

    for (const sid of scanIds) {
      try {
        const { data: metaBlob } = await supabase.storage
          .from('raw-scans')
          .download(`${sid}/meta.json`)
        if (metaBlob) {
          const meta = JSON.parse(await metaBlob.text())
          scanFilenames[sid] = meta.originalFilename || 'scan.pdf'
        }
      } catch { scanFilenames[sid] = 'scan.pdf' }
    }

    // ── Reprocess each page: OCR + analyze ───────────────────────────────────
    const tasks = pages.map((page) => async () => {
      const { scan_id, page_number } = page

      await supabase.from('page_hashes')
        .update({ status: 'processing', error_message: null })
        .eq('id', page.id)

      try {
        // OCR
        const ocrText = await ocrPageWithVision(supabase, scan_id, page_number, token)

        await supabase.from('page_hashes')
          .update({ status: 'ocr_complete', ocr_text: ocrText })
          .eq('id', page.id)

        // Analyze
        const analyzed = await callFunction('analyze-page', {
          page: page_number,
          text: ocrText,
          fileName: scanFilenames[scan_id] || 'scan.pdf',
        }) as AnalyzedPage

        await supabase.from('page_hashes')
          .update({ analysis: analyzed })
          .eq('id', page.id)

        console.log(`[reprocess-pages] OK: scan=${scan_id} page=${page_number}`)
        return { success: true, id: page.id }
      } catch (err) {
        const msg = (err as Error).message
        console.error(`[reprocess-pages] FEHLER scan=${scan_id} page=${page_number}:`, msg)

        await supabase.from('page_hashes')
          .update({ status: 'error', error_message: msg })
          .eq('id', page.id)

        return { success: false, id: page.id, error: msg }
      }
    })

    const results = await pLimit(tasks, 5)

    // ── Prepare ocr_results in raw_scans for each affected scan ──────────────
    // (Clustering is triggered by the frontend so it runs with the user JWT)
    const processedScanIds = [...new Set(
      results
        .filter(r => r.success)
        .map(r => pages.find(p => p.id === r.id)?.scan_id)
        .filter(Boolean)
    )] as string[]

    for (const sid of processedScanIds) {
      try {
        const { data: analyzedRows } = await supabase
          .from('page_hashes')
          .select('page_number, analysis')
          .eq('scan_id', sid)
          .not('analysis', 'is', null)
          .order('page_number')

        if (!analyzedRows || analyzedRows.length === 0) continue

        const ocrResults = analyzedRows.map(r => ({ ...r.analysis, page: r.page_number }))

        await supabase.from('raw_scans')
          .update({ status: 'ocr_complete', ocr_results: ocrResults })
          .eq('id', sid)
      } catch (err) {
        console.error(`[reprocess-pages] ocr_results update FEHLER scan=${sid}:`, (err as Error).message)
      }
    }

    const successCount = results.filter(r => r.success).length
    const errorCount = results.filter(r => !r.success).length

    return new Response(
      JSON.stringify({
        success: true,
        reprocessed: successCount,
        errors: errorCount,
        // Return scan IDs so the frontend can trigger process-cluster for each
        scanIds: processedScanIds,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('[reprocess-pages] FEHLER:', (error as Error).message)

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
