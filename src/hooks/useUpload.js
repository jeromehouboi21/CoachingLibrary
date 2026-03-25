import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { convertPdfToPages } from '../lib/pdfToPages'

/**
 * Pipeline result from raw_scans.pipeline_results JSONB:
 * { status: 'created' | 'merged' | 'duplicate' | 'error' | 'processing', topic_label: string, doc_id?: string }
 */

export function useUpload() {
  // idle | converting | uploading | processing | done | error
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
        // Single image: treat as one-page upload
        pages = [{ pageNumber: 1, blob: file, filename: 'page_001.png' }]
        resolvedPageCount = 1
        setConvertProgress({ current: 1, total: 1 })
      }

      setPageCount(resolvedPageCount)

      // ── Phase 2: Upload PNGs + meta.json to Storage ─────────────────────────
      setStatus('uploading')
      setUploadProgress({ current: 0, total: resolvedPageCount })

      // Create raw_scans record before uploading
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

      // Upload PNGs sequentially (avoid overloading Storage)
      for (const page of pages) {
        const { error: uploadError } = await supabase.storage
          .from('raw-scans')
          .upload(`${scanId}/${page.filename}`, page.blob, { contentType: 'image/png' })
        if (uploadError) throw uploadError
        setUploadProgress(prev => ({ ...prev, current: page.pageNumber }))
      }

      // Mark as pending and trigger the pipeline
      await supabase.from('raw_scans')
        .update({ status: 'pending' })
        .eq('id', scanId)

      setStatus('processing')

      // Trigger orchestrator (non-blocking — Edge Function runs async)
      supabase.functions.invoke('process-upload', {
        body: { scanId, pageCount: resolvedPageCount },
      }).catch(err => console.warn('process-upload invoke error:', err))

      // ── Phase 3: Poll DB for live pipeline progress ─────────────────────────
      pollRef.current = setInterval(async () => {
        const { data } = await supabase
          .from('raw_scans')
          .select('status, page_count, pipeline_results, error_message')
          .eq('id', scanId)
          .single()

        if (!data) return

        if (data.pipeline_results) setPipelineResults(data.pipeline_results)

        if (data.status === 'processed') {
          clearInterval(pollRef.current)
          setStatus('done')
        } else if (data.status === 'error') {
          clearInterval(pollRef.current)
          setError(data.error_message || 'Verarbeitungsfehler')
          setStatus('error')
        }
      }, 2000)
    } catch (err) {
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

  // Derived stats from pipeline_results
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
