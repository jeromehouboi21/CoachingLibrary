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

/** Link page_hashes entries (by scan + page numbers) to a processed doc */
async function linkPageHashes(
  supabase: ReturnType<typeof createClient>,
  scanId: string,
  pageNumbers: number[],
  docId: string
): Promise<void> {
  const { error } = await supabase
    .from('page_hashes')
    .update({ doc_id: docId })
    .eq('scan_id', scanId)
    .in('page_number', pageNumbers)
  if (error) console.warn('[process-cluster] page_hashes update failed:', error.message)
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

    console.log('[process-cluster] gestartet', { scanId })

    if (!scanId) throw new Error('Missing required parameter: scanId')

    // ── Step 1: Load OCR results from DB ─────────────────────────────────────
    const { data: scan, error: scanError } = await supabase
      .from('raw_scans')
      .select('ocr_results, filename')
      .eq('id', scanId)
      .single()

    if (scanError) throw scanError
    if (!scan?.ocr_results) throw new Error('Keine OCR-Ergebnisse gefunden. process-ocr zuerst ausführen.')

    const analyzedPages: AnalyzedPage[] = scan.ocr_results
    const originalFilename: string = scan.filename || 'scan.pdf'

    console.log('[process-cluster]', analyzedPages.length, 'Seiten geladen, Clustering startet…')

    // ── Step 2: Cluster pages by embedding similarity ─────────────────────────
    const pageGroups = clusterByEmbedding(analyzedPages, 0.82)
    console.log('[process-cluster] Clustering →', pageGroups.length, 'Gruppen')

    const pipelineResults: PipelineResult[] = pageGroups.map(g => ({
      status: 'processing',
      topic_label: g.topic_label,
    }))

    await supabase.from('raw_scans')
      .update({ status: 'processing', pipeline_results: pipelineResults })
      .eq('id', scanId)

    // ── Step 3: For each group → find merge candidate → merge or create ───────
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
        // Continue with next group — one failure does not abort the pipeline
      }

      // Write intermediate progress after each group
      await supabase.from('raw_scans')
        .update({ pipeline_results: [...pipelineResults] })
        .eq('id', scanId)
    }

    await supabase.from('raw_scans').update({ status: 'processed' }).eq('id', scanId)

    console.log('[process-cluster] abgeschlossen:', pipelineResults.length, 'Gruppen')

    return new Response(
      JSON.stringify({ success: true, groups: pageGroups.length, results: pipelineResults }),
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
