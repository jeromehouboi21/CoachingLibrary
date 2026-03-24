import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface RawPage { page: number; text: string }

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract pages from a file. For PDFs uses pdf-parse to get numpages. */
async function extractPdfPages(fileData: Blob, fileName: string): Promise<{ pageCount: number; pages: RawPage[] }> {
  const isPdf = fileName.toLowerCase().endsWith('.pdf')

  if (isPdf) {
    try {
      // Dynamic import — @ts-ignore suppresses the local TS resolver error;
      // at runtime Deno resolves URL imports correctly.
      // @ts-ignore: URL import, valid in Deno
      const { default: pdfParse } = await import('https://esm.sh/pdf-parse@1.1.1')
      const arrayBuffer = await fileData.arrayBuffer()
      const buffer = new Uint8Array(arrayBuffer)
      const data = await pdfParse(buffer)

      const pageCount: number = data.numpages
      const fullText: string = data.text || ''

      const pages = splitTextByPageCount(fullText, pageCount, fileName)
      return { pageCount, pages }
    } catch (err) {
      console.warn('pdf-parse failed, falling back to text split:', err)
    }
  }

  // Fallback for images or failed PDF parsing: treat the whole file as one page
  const rawText = await fileData.text().catch(() => `[Nicht lesbar: ${fileName}]`)
  return { pageCount: 1, pages: [{ page: 1, text: rawText }] }
}

/** Split a full-document text into individual page objects. */
function splitTextByPageCount(text: string, pageCount: number, fileName: string): RawPage[] {
  if (!text?.trim()) {
    // Scanned PDF — no extractable text, create one placeholder per page
    return Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      text: `[Seite ${i + 1} aus ${fileName} – gescanntes Bild, OCR erforderlich]`,
    }))
  }

  // If pdf-parse inserted form-feeds between pages, use those
  const ffParts = text.split('\f').map(t => t.trim()).filter(t => t.length > 0)
  if (ffParts.length === pageCount) {
    return ffParts.map((t, i) => ({ page: i + 1, text: t }))
  }

  // Otherwise split evenly by line count
  const lines = text.split('\n')
  const linesPerPage = Math.max(1, Math.ceil(lines.length / pageCount))
  return Array.from({ length: pageCount }, (_, i) => ({
    page: i + 1,
    text: lines.slice(i * linesPerPage, (i + 1) * linesPerPage).join('\n').trim(),
  }))
}

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
    const { filePath, fileName } = body

    if (!scanId || !filePath || !fileName) {
      throw new Error('Missing required parameters: scanId, filePath, fileName')
    }

    await supabase.from('raw_scans').update({ status: 'processing', pipeline_results: [] }).eq('id', scanId)

    // ── Step 0: Download file ──────────────────────────────────────────────
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('raw-scans')
      .download(filePath)
    if (downloadError) throw downloadError

    // Use pdf-parse for PDFs to get the correct numpages value
    const { pageCount, pages: rawPages } = await extractPdfPages(fileData, fileName)

    await supabase.from('raw_scans').update({ page_count: pageCount }).eq('id', scanId)

    // ── Step 1: Analyze each page with Claude Haiku (max 5 parallel) ──────
    const analyzeTasks = rawPages.map((p: RawPage) => async () => {
      try {
        return await callFunction('analyze-page', {
          page: p.page,
          text: p.text,
          fileName,
        }) as AnalyzedPage
      } catch {
        // Fallback: return a minimal analyzed page without embedding
        return {
          page: p.page,
          topic_key: `page_${p.page}`,
          topic_label: `Seite ${p.page}`,
          topic_embedding_text: p.text.slice(0, 200),
          content_html: `<p>${p.text.slice(0, 500)}</p>`,
          key_concepts: [],
        } as AnalyzedPage
      }
    })

    const analyzedPages = (await pLimit(analyzeTasks, 5)) as AnalyzedPage[]

    // ── Step 2: Intra-document clustering (threshold 0.82) ────────────────
    const pageGroups = clusterByEmbedding(analyzedPages, 0.82)

    const pipelineResults: PipelineResult[] = pageGroups.map(g => ({
      status: 'processing',
      topic_label: g.topic_label,
    }))

    await supabase.from('raw_scans').update({ pipeline_results: pipelineResults }).eq('id', scanId)

    // ── Step 3: For each group → find merge candidate → merge or create ───
    for (let gi = 0; gi < pageGroups.length; gi++) {
      const group = pageGroups[gi]

      try {
        // Compute group embedding (average of page embeddings)
        const validEmbeddings = group.pages.map(p => p.embedding).filter(Boolean) as number[][]
        const groupEmbedding = validEmbeddings.length > 0 ? averageEmbedding(validEmbeddings) : null

        let result: PipelineResult

        if (groupEmbedding) {
          // Phase A+B: find merge candidate
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
              // Merge content into existing doc
              const combinedHtml = group.pages.map(p => p.content_html).join('\n')
              await callFunction('merge-into-document', {
                docId: mergeDecision.merge_candidate_id,
                newContentHtml: combinedHtml,
                mergeType: mergeDecision.merge_type || 'append',
              })
              result = { status: 'merged', topic_label: group.topic_label, doc_id: mergeDecision.merge_candidate_id }
            }
          } else {
            // Create new document
            const created = await callFunction('create-document', {
              pages: group.pages.map(p => ({ page: p.page, content_html: p.content_html, topic_label: p.topic_label })),
              scanId,
              fileName,
            }) as { docId: string; title: string }
            result = { status: 'created', topic_label: created.title || group.topic_label, doc_id: created.docId }
          }
        } else {
          // No embeddings available → always create
          const created = await callFunction('create-document', {
            pages: group.pages.map(p => ({ page: p.page, content_html: p.content_html, topic_label: p.topic_label })),
            scanId,
            fileName,
          }) as { docId: string; title: string }
          result = { status: 'created', topic_label: created.title || group.topic_label, doc_id: created.docId }
        }

        pipelineResults[gi] = result
      } catch (groupErr) {
        pipelineResults[gi] = { status: 'error', topic_label: group.topic_label }
        console.error(`Group ${gi} failed:`, groupErr)
      }

      // Write intermediate progress after each group
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
      await supabase.from('raw_scans').update({
        status: 'error',
        error_message: (error as Error).message,
      }).eq('id', scanId).catch(() => {})
    }

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
