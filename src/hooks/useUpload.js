import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { convertPdfToPages } from '../lib/pdfToPages'

export function useUpload() {
  // idle | converting | uploading | analyzing | clustering | done | error
  const [status, setStatus] = useState('idle')
  const [pipelineResults, setPipelineResults] = useState([])
  const [convertProgress, setConvertProgress] = useState({ current: 0, total: 0 })
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, skipped: 0 })
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  async function uploadFile(file) {
    setStatus('converting')
    setPipelineResults([])
    setConvertProgress({ current: 0, total: 0 })
    setUploadProgress({ current: 0, total: 0, skipped: 0 })
    setPageCount(0)
    setError(null)

    try {
      const scanId = crypto.randomUUID()

      // ── Phase 1: PDF → PNGs with SHA-256 hashes (client-side, PDF.js) ───────
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

      let pages, resolvedPageCount

      if (isPdf) {
        const result = await convertPdfToPages(file, ({ current, total }) => {
          setConvertProgress({ current, total })
        })
        pages = result.pages
        resolvedPageCount = result.pageCount
      } else {
        // Single image: compute hash manually
        const arrayBuffer = await file.arrayBuffer()
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer)
        const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
        pages = [{ pageNumber: 1, blob: file, filename: 'page_001.png', hash }]
        resolvedPageCount = 1
        setConvertProgress({ current: 1, total: 1 })
      }

      setPageCount(resolvedPageCount)

      // ── Phase 2: Hash-check + conditional upload ──────────────────────────
      setStatus('uploading')
      setUploadProgress({ current: 0, total: resolvedPageCount, skipped: 0 })

      // Create raw_scans record
      const { error: dbError } = await supabase.from('raw_scans').insert({
        id: scanId,
        filename: file.name,
        storage_path: `${scanId}/meta.json`,
        status: 'converting',
        page_count: resolvedPageCount,
      })
      if (dbError) throw dbError

      // Upload meta.json
      await supabase.storage.from('raw-scans').upload(
        `${scanId}/meta.json`,
        new Blob(
          [JSON.stringify({ pageCount: resolvedPageCount, originalFilename: file.name })],
          { type: 'application/json' }
        )
      )

      const newPageFilenames = []
      let skippedCount = 0

      for (const page of pages) {
        // Only skip if page was fully processed (status='processed' AND doc_id set)
        const { data: existingHash } = await supabase
          .from('page_hashes')
          .select('id, status, doc_id')
          .eq('hash', page.hash)
          .maybeSingle()

        const fullyProcessed = existingHash?.status === 'processed' && existingHash?.doc_id != null

        if (fullyProcessed) {
          skippedCount++
          setUploadProgress({ current: page.pageNumber, total: resolvedPageCount, skipped: skippedCount })
          continue
        }

        // New or failed page → upload (or re-upload if needed)
        if (!existingHash) {
          const { error: uploadError } = await supabase.storage
            .from('raw-scans')
            .upload(`${scanId}/${page.filename}`, page.blob, { contentType: 'image/png' })
          if (uploadError) throw uploadError
        }

        // Upsert hash record so failed pages get a fresh scan_id/page_number
        await supabase.from('page_hashes').upsert({
          hash: page.hash,
          scan_id: scanId,
          page_number: page.pageNumber,
          status: 'uploaded',
          ocr_text: null,
          analysis: null,
          error_message: null,
          doc_id: null,
        }, { onConflict: 'hash' })

        newPageFilenames.push(page.filename)
        setUploadProgress({ current: page.pageNumber, total: resolvedPageCount, skipped: skippedCount })
      }

      // All pages already known → done without API calls
      if (newPageFilenames.length === 0) {
        await supabase.from('raw_scans').update({ status: 'processed', pipeline_results: [] }).eq('id', scanId)
        setStatus('done')
        return
      }

      // ── Phase 3: OCR + Haiku analysis (Edge Function: process-ocr) ──────────
      setStatus('analyzing')

      // Fetch session once for both invocations — prevents 401 after long uploads
      const { data: { session } } = await supabase.auth.getSession()
      const authHeader = { Authorization: `Bearer ${session?.access_token}` }

      const { error: ocrError } = await supabase.functions.invoke('process-ocr', {
        body: { scanId, pageFilenames: newPageFilenames },
        headers: authHeader,
      })
      if (ocrError) throw new Error(`OCR fehlgeschlagen: ${ocrError.message}`)

      // ── Phase 4: Clustering + DB integration (Edge Function: process-cluster) ─
      setStatus('clustering')

      // Poll for live group results during clustering
      pollRef.current = setInterval(async () => {
        const { data } = await supabase
          .from('raw_scans')
          .select('pipeline_results')
          .eq('id', scanId)
          .single()
        if (data?.pipeline_results) setPipelineResults(data.pipeline_results)
      }, 2000)

      const { error: clusterError } = await supabase.functions.invoke('process-cluster', {
        body: { scanId },
        headers: authHeader,
      })

      clearInterval(pollRef.current)
      pollRef.current = null

      if (clusterError) throw new Error(`Clustering fehlgeschlagen: ${clusterError.message}`)

      // Final read for complete results
      const { data: finalScan } = await supabase
        .from('raw_scans')
        .select('pipeline_results')
        .eq('id', scanId)
        .single()
      if (finalScan?.pipeline_results) setPipelineResults(finalScan.pipeline_results)

      setStatus('done')
    } catch (err) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      setError(err.message)
      setStatus('error')
    }
  }

  function reset() {
    if (pollRef.current) clearInterval(pollRef.current)
    setStatus('idle')
    setPipelineResults([])
    setConvertProgress({ current: 0, total: 0 })
    setUploadProgress({ current: 0, total: 0, skipped: 0 })
    setPageCount(0)
    setError(null)
  }

  const stats = {
    total: pipelineResults.length,
    done: pipelineResults.filter(r => r.status !== 'processing').length,
    created: pipelineResults.filter(r => r.status === 'created').length,
    merged: pipelineResults.filter(r => r.status === 'merged').length,
    duplicate: pipelineResults.filter(r => r.status === 'duplicate').length,
    errors: pipelineResults.filter(r => r.status === 'error').length,
    createdDocs: pipelineResults.filter(r => r.status === 'created' && r.doc_id),
  }

  return {
    uploadFile,
    status,
    pipelineResults,
    convertProgress,
    uploadProgress,
    pageCount,
    stats,
    error,
    reset,
  }
}
