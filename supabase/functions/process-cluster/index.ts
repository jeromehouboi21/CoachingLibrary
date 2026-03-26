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
  error_message?: string
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

/** Link page_hashes entries (by scan + page numbers) to a processed doc and mark as processed */
async function linkPageHashes(
  supabase: ReturnType<typeof createClient>,
  scanId: string,
  pageNumbers: number[],
  docId: string
): Promise<void> {
  const { error } = await supabase
    .from('page_hashes')
    .update({ doc_id: docId, status: 'processed' })
    .eq('scan_id', scanId)
    .in('page_number', pageNumbers)
  if (error) console.warn('[process-cluster] page_hashes update failed:', error.message)
}

/** Mark page_hashes entries as error */
async function markPageHashesError(
  supabase: ReturnType<typeof createClient>,
  scanId: string,
  pageNumbers: number[],
  errorMessage: string
): Promise<void> {
  const { error } = await supabase
    .from('page_hashes')
    .update({ status: 'error', error_message: errorMessage })
    .eq('scan_id', scanId)
    .in('page_number', pageNumbers)
  if (error) console.warn('[process-cluster] page_hashes error update failed:', error.message)
}

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
    const startIndex: number = body.startIndex ?? 0
    const batchSize: number = body.batchSize ?? 3

    console.log('[process-cluster] gestartet', { scanId, startIndex, batchSize })

    if (!scanId) throw new Error('Missing required parameter: scanId')

    // ── Step 1: Load OCR results + existing cluster groups ───────────────────
    const { data: scan, error: scanError } = await supabase
      .from('raw_scans')
      .select('ocr_results, cluster_groups, pipeline_results, filename')
      .eq('id', scanId)
      .single()

    if (scanError) throw scanError
    if (!scan?.ocr_results) throw new Error('Keine OCR-Ergebnisse gefunden. process-ocr zuerst ausführen.')

    const originalFilename: string = scan.filename || 'scan.pdf'

    // ── Step 2: Cluster (only on first call) or load saved groups ────────────
    let pageGroups: PageGroup[]

    if (startIndex === 0) {
      const analyzedPages: AnalyzedPage[] = scan.ocr_results
      console.log('[process-cluster]', analyzedPages.length, 'Seiten geladen, Clustering startet…')

      pageGroups = clusterByEmbedding(analyzedPages, 0.82)
      console.log('[process-cluster] Clustering →', pageGroups.length, 'Gruppen')

      // Save groups + initial pipeline_results for subsequent calls
      const initialResults: PipelineResult[] = pageGroups.map(g => ({
        status: 'processing',
        topic_label: g.topic_label,
      }))

      await supabase.from('raw_scans')
        .update({ status: 'processing', cluster_groups: pageGroups, pipeline_results: initialResults })
        .eq('id', scanId)
    } else {
      if (!scan?.cluster_groups) throw new Error('cluster_groups fehlt – startIndex > 0 erfordert vorherigen Aufruf mit startIndex=0')
      pageGroups = scan.cluster_groups as PageGroup[]
      console.log('[process-cluster] Gruppen aus DB geladen:', pageGroups.length)
    }

    // Accumulate pipeline_results across batches
    const pipelineResults: PipelineResult[] = (scan?.pipeline_results as PipelineResult[]) ?? pageGroups.map(g => ({
      status: 'processing' as const,
      topic_label: g.topic_label,
    }))

    // ── Step 3: Process only the current batch ────────────────────────────────
    const batchEnd = Math.min(startIndex + batchSize, pageGroups.length)
    console.log(`[process-cluster] Batch: Gruppen ${startIndex}–${batchEnd - 1} von ${pageGroups.length}`)

    for (let i = 0; i < batchEnd - startIndex; i++) {
      const gi = startIndex + i
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
              await linkPageHashes(supabase, scanId!, group.pages.map(p => p.page), mergeDecision.merge_candidate_id)
            } else {
              const combinedHtml = group.pages.map(p => p.content_html).join('\n')
              await callFunction('merge-into-document', {
                docId: mergeDecision.merge_candidate_id,
                newContentHtml: combinedHtml,
                mergeType: mergeDecision.merge_type || 'append',
              })
              result = { status: 'merged', topic_label: group.topic_label, doc_id: mergeDecision.merge_candidate_id }
              await linkPageHashes(supabase, scanId!, group.pages.map(p => p.page), mergeDecision.merge_candidate_id)
            }
          } else {
            const created = await callFunction('create-document', {
              pages: group.pages.map(p => ({ page: p.page, content_html: p.content_html, topic_label: p.topic_label })),
              scanId,
              fileName: originalFilename,
            }) as { docId: string; title: string }
            result = { status: 'created', topic_label: created.title || group.topic_label, doc_id: created.docId }
            await linkPageHashes(supabase, scanId!, group.pages.map(p => p.page), created.docId)
          }
        } else {
          // No embedding available → always create
          const created = await callFunction('create-document', {
            pages: group.pages.map(p => ({ page: p.page, content_html: p.content_html, topic_label: p.topic_label })),
            scanId,
            fileName: originalFilename,
          }) as { docId: string; title: string }
          result = { status: 'created', topic_label: created.title || group.topic_label, doc_id: created.docId }
          await linkPageHashes(supabase, scanId!, group.pages.map(p => p.page), created.docId)
        }

        pipelineResults[gi] = result
        console.log(`[process-cluster] Gruppe ${gi} OK: ${result.status} → "${result.topic_label}"`)
      } catch (groupErr) {
        const msg = (groupErr as Error).message ?? String(groupErr)
        pipelineResults[gi] = { status: 'error', topic_label: group.topic_label, error_message: msg }
        console.error(`[process-cluster] Gruppe ${gi} (${group.topic_label}) FEHLER:`, msg)
        await markPageHashesError(supabase, scanId!, group.pages.map(p => p.page), msg)
        // Continue with next group — one failure does not abort the pipeline
      }

      // Write intermediate progress after each group
      await supabase.from('raw_scans')
        .update({ pipeline_results: [...pipelineResults] })
        .eq('id', scanId)
    }

    const nextIndex = batchEnd < pageGroups.length ? batchEnd : null

    if (nextIndex !== null) {
      // Fire-and-forget: trigger next batch without awaiting (self-orchestration)
      // This allows the current response to return immediately while the pipeline continues
      const nextUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/process-cluster`
      fetch(nextUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify({ scanId, startIndex: nextIndex, batchSize }),
      }).catch(err => console.error('[process-cluster] Next batch trigger failed:', err.message))

      console.log(`[process-cluster] Nächster Batch getriggert: startIndex=${nextIndex}`)
    } else {
      await supabase.from('raw_scans').update({ status: 'processed' }).eq('id', scanId)
      console.log('[process-cluster] alle Gruppen verarbeitet – fertig')
    }

    return new Response(
      JSON.stringify({ success: true, batchProcessed: batchEnd - startIndex, nextIndex, totalGroups: pageGroups.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('[process-cluster] FEHLER:', (error as Error).message)

    if (scanId) {
      const { error: updateError } = await supabase.from('raw_scans').update({
        status: 'error',
        error_message: (error as Error).message,
      }).eq('id', scanId)
      if (updateError) console.error('[process-cluster] Status-Update fehlgeschlagen:', updateError.message)
    }

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
