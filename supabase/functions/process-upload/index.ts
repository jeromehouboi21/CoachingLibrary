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

interface PageGroup {
  pages: AnalyzedPage[]
  topic_label: string
}

interface PipelineResult {
  status: 'created' | 'merged' | 'duplicate' | 'error' | 'processing'
  topic_label: string
  doc_id?: string
}

// ─── Google Vision API ────────────────────────────────────────────────────────

/** Exchange a service-account key for a short-lived access token */
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

  // Parse PEM → DER
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
  if (!tokenData.access_token) {
    throw new Error(`Google auth failed: ${JSON.stringify(tokenData)}`)
  }
  return tokenData.access_token
}

/** Download a page PNG from Storage and run DOCUMENT_TEXT_DETECTION via Vision API */
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
  // Convert to base64 in chunks to avoid call stack overflow on large pages
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

function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0)
}

function cosineSimilarity(a: number[], b: number[]): number {
  const magA = Math.sqrt(dotProduct(a, a))
  const magB = Math.sqrt(dotProduct(b, b))
  if (magA === 0 || magB === 0) return 0
  return dotProduct(a, b) / (magA * magB)
}

function averageEmbedding(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return []
  const dim = embeddings[0].length
  const avg = new Array(dim).fill(0)
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i]
  }
  return avg.map(v => v / embeddings.length)
}

/** Cluster analyzed pages by embedding similarity (threshold 0.82) */
function clusterByEmbedding(pages: AnalyzedPage[], threshold = 0.82): PageGroup[] {
  const assigned = new Set<number>()
  const groups: PageGroup[] = []

  for (let i = 0; i < pages.length; i++) {
    if (assigned.has(i)) continue

    const group: AnalyzedPage[] = [pages[i]]
    assigned.add(i)

    if (pages[i].embedding) {
      for (let j = i + 1; j < pages.length; j++) {
        if (assigned.has(j) || !pages[j].embedding) continue
        const sim = cosineSimilarity(pages[i].embedding!, pages[j].embedding!)
        if (sim >= threshold) {
          group.push(pages[j])
          assigned.add(j)
        }
      }
    }

    groups.push({ pages: group, topic_label: pages[i].topic_label })
  }

  return groups
}

/** Call an internal Edge Function by name */
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

/** Run up to `concurrency` async tasks at a time */
async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = []
  let idx = 0

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  await Promise.all(workers)
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

    console.log('[process-upload] gestartet', { scanId, pageCount })

    if (!scanId || !pageCount) {
      throw new Error('Missing required parameters: scanId, pageCount')
    }

    await supabase.from('raw_scans')
      .update({ status: 'processing', pipeline_results: [] })
      .eq('id', scanId)

    // ── Step 1: OCR all PNGs via Google Vision API (max 5 parallel) ──────────
    console.log('[process-upload] Step 1: Google Access Token holen…')
    const clientEmail = Deno.env.get('GOOGLE_CLIENT_EMAIL')
    const privateKey = Deno.env.get('GOOGLE_PRIVATE_KEY')?.replace(/\\n/g, '\n')
    if (!clientEmail) throw new Error('Secret GOOGLE_CLIENT_EMAIL fehlt')
    if (!privateKey) throw new Error('Secret GOOGLE_PRIVATE_KEY fehlt')

    const token = await getGoogleAccessToken(clientEmail, privateKey)
    console.log('[process-upload] Access Token erhalten')

    const pageFilenames = Array.from({ length: pageCount }, (_, i) =>
      `page_${String(i + 1).padStart(3, '0')}.png`
    )
    console.log('[process-upload] Seiten:', pageFilenames)

    // Read originalFilename from meta.json for use in analyze-page prompts
    let originalFilename = 'scan.pdf'
    try {
      const { data: metaBlob } = await supabase.storage
        .from('raw-scans')
        .download(`${scanId}/meta.json`)
      if (metaBlob) {
        const meta = JSON.parse(await metaBlob.text())
        if (meta.originalFilename) originalFilename = meta.originalFilename
      }
      console.log('[process-upload] originalFilename:', originalFilename)
    } catch (metaErr) {
      console.warn('[process-upload] meta.json nicht lesbar:', metaErr)
    }

    console.log('[process-upload] Step 1: OCR startet für', pageFilenames.length, 'Seiten…')
    const ocrTasks = pageFilenames.map((filename) => async () => {
      try {
        const text = await ocrPageWithVision(supabase, scanId!, filename, token)
        console.log(`[process-upload] OCR OK: ${filename} → ${text.length} Zeichen`)
        return text
      } catch (err) {
        console.error(`[process-upload] OCR FEHLER: ${filename}:`, (err as Error).message)
        return `[Seite nicht lesbar: ${filename}]`
      }
    })

    const pageTexts: string[] = await pLimit(ocrTasks, 5)
    console.log('[process-upload] Step 1 abgeschlossen, Texte:', pageTexts.map(t => t.length))

    // ── Step 2: Analyze each page text with Claude Haiku (max 5 parallel) ────
    console.log('[process-upload] Step 2: Haiku-Analyse startet…')
    const analyzeTasks = pageTexts.map((text, i) => async () => {
      try {
        const result = await callFunction('analyze-page', {
          page: i + 1,
          text,
          fileName: originalFilename,
        }) as AnalyzedPage
        console.log(`[process-upload] analyze-page OK: Seite ${i + 1} → ${result.topic_label}`)
        return result
      } catch (err) {
        console.error(`[process-upload] analyze-page FEHLER Seite ${i + 1}:`, (err as Error).message)
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
    console.log('[process-upload] Step 2 abgeschlossen:', analyzedPages.map(p => p.topic_label))

    // ── Step 3: Intra-document clustering (threshold 0.82) ───────────────────
    const pageGroups = clusterByEmbedding(analyzedPages, 0.82)
    console.log('[process-upload] Step 3: Clustering → ', pageGroups.length, 'Gruppen')

    const pipelineResults: PipelineResult[] = pageGroups.map(g => ({
      status: 'processing',
      topic_label: g.topic_label,
    }))

    await supabase.from('raw_scans').update({ pipeline_results: pipelineResults }).eq('id', scanId)

    // ── Step 4: For each group → find merge candidate → merge or create ───────
    for (let gi = 0; gi < pageGroups.length; gi++) {
      const group = pageGroups[gi]

      try {
        const validEmbeddings = group.pages.map(p => p.embedding).filter(Boolean) as number[][]
        const groupEmbedding = validEmbeddings.length > 0 ? averageEmbedding(validEmbeddings) : null

        let result: PipelineResult

        if (groupEmbedding) {
          const mergeDecision = await callFunction('find-merge-candidate', {
            groupEmbedding,
            topicLabel: group.topic_label,
            topicEmbeddingText: group.pages[0]?.topic_embedding_text || group.topic_label,
            keyConcepts: group.pages.flatMap(p => p.key_concepts).slice(0, 10),
          }) as { decision: string; merge_candidate_id: string | null; merge_type: string | null }

          if (mergeDecision.decision === 'merge' && mergeDecision.merge_candidate_id) {
            if (mergeDecision.merge_type === 'duplicate') {
              result = { status: 'duplicate', topic_label: group.topic_label, doc_id: mergeDecision.merge_candidate_id }
            } else {
              const combinedHtml = group.pages.map(p => p.content_html).join('\n')
              await callFunction('merge-into-document', {
                docId: mergeDecision.merge_candidate_id,
                newContentHtml: combinedHtml,
                mergeType: mergeDecision.merge_type || 'append',
              })
              result = { status: 'merged', topic_label: group.topic_label, doc_id: mergeDecision.merge_candidate_id }
            }
          } else {
            const created = await callFunction('create-document', {
              pages: group.pages.map(p => ({ page: p.page, content_html: p.content_html, topic_label: p.topic_label })),
              scanId,
              fileName: originalFilename,
            }) as { docId: string; title: string }
            result = { status: 'created', topic_label: created.title || group.topic_label, doc_id: created.docId }
          }
        } else {
          const created = await callFunction('create-document', {
            pages: group.pages.map(p => ({ page: p.page, content_html: p.content_html, topic_label: p.topic_label })),
            scanId,
            fileName: originalFilename,
          }) as { docId: string; title: string }
          result = { status: 'created', topic_label: created.title || group.topic_label, doc_id: created.docId }
        }

        pipelineResults[gi] = result
      } catch (groupErr) {
        pipelineResults[gi] = { status: 'error', topic_label: group.topic_label }
        console.error(`Group ${gi} failed:`, groupErr)
      }

      await supabase.from('raw_scans').update({ pipeline_results: [...pipelineResults] }).eq('id', scanId)
    }

    await supabase.from('raw_scans').update({ status: 'processed' }).eq('id', scanId)

    return new Response(
      JSON.stringify({ success: true, groups: pageGroups.length, results: pipelineResults }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('process-upload error:', error)

    if (scanId) {
      const { error: updateError } = await supabase.from('raw_scans').update({
        status: 'error',
        error_message: (error as Error).message,
      }).eq('id', scanId)
      if (updateError) console.error('[process-upload] Status-Update fehlgeschlagen:', updateError.message)
    }

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
