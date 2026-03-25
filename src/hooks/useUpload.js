import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { convertPdfToPages } from '../lib/pdfToPages'

/**
 * Pipeline result from raw_scans.pipeline_results JSONB:
 * { status: 'created' | 'merged' | 'duplicate' | 'error' | 'processing', topic_label, doc_id?, error_message? }
 */

export function useUpload() {
  // idle | converting | uploading | analyzing | clustering | done | error
  const [status, setStatus] = useState('idle')
  const [pipelineResults, setPipelineResults] = useState([])
  const [convertProgress, setConvertProgress] = useState({ current: 0, total: 0 })
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 })
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  async function uploadFile(file) {
    setStatus('converting')
    setPipelineResults([])
    setConvertProgress({ current: 0, total: 0 })
    setUploadProgress({ current: 0, total: 0 })
    setPageCount(0)
    setError(null)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      const scanId = crypto.randomUUID()

      // ── Phase 1: PDF → PNGs (client-side, PDF.js) ──────────────────────────
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

      let pages, resolvedPageCount

      if (isPdf) {
        const result = await convertPdfToPages(file, ({ current, total }) => {
          setConvertProgress({ current, total })
        })
        pages = result.pages
        resolvedPageCount = result.pageCount
      } else {
        pages = [{ pageNumber: 1, blob: file, filename: 'page_001.png' }]
        resolvedPageCount = 1
        setConvertProgress({ current: 1, total: 1 })
      }

      setPageCount(resolvedPageCount)

      // ── Phase 2: Upload PNGs + meta.json to Storage ─────────────────────────
      setStatus('uploading')
      setUploadProgress({ current: 0, total: resolvedPageCount })

      const { error: dbError } = await supabase.from('raw_scans').insert({
        id: scanId,
        filename: file.name,
        storage_path: `${scanId}/meta.json`,
        status: 'converting',
        page_count: resolvedPageCount,
      })
      if (dbError) throw dbError

      await supabase.storage.from('raw-scans').upload(
        `${scanId}/meta.json`,
        new Blob(
          [JSON.stringify({ pageCount: resolvedPageCount, originalFilename: file.name })],
          { type: 'application/json' }
        )
      )

      for (const page of pages) {
        const { error: uploadError } = await supabase.storage
          .from('raw-scans')
          .upload(`${scanId}/${page.filename}`, page.blob, { contentType: 'image/png' })
        if (uploadError) throw uploadError
        setUploadProgress(prev => ({ ...prev, current: page.pageNumber }))
      }

      // ── Phase 3: OCR + Haiku analysis (Edge Function: process-ocr) ──────────
      setStatus('analyzing')

      const { error: ocrError } = await supabase.functions.invoke('process-ocr', {
        body: { scanId, pageCount: resolvedPageCount },
      })
      if (ocrError) throw new Error(`OCR fehlgeschlagen: ${ocrError.message}`)

      // ── Phase 4: Clustering + DB integration (Edge Function: process-cluster) ─
      setStatus('clustering')

      // Start polling for live group results during clustering
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
      })

      clearInterval(pollRef.current)
      pollRef.current = null

      if (clusterError) throw new Error(`Clustering fehlgeschlagen: ${clusterError.message}`)

      // Final read to get complete results
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
    setUploadProgress({ current: 0, total: 0 })
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
