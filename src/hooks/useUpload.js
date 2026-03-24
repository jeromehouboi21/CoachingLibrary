import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Pipeline result from raw_scans.pipeline_results JSONB:
 * { status: 'created' | 'merged' | 'duplicate' | 'error' | 'processing', topic_label: string, doc_id?: string }
 */

export function useUpload() {
  const [status, setStatus] = useState('idle') // idle | uploading | processing | done | error
  const [pipelineResults, setPipelineResults] = useState([])  // live pipeline_results from DB
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  async function uploadFile(file) {
    setStatus('uploading')
    setPipelineResults([])
    setPageCount(0)
    setError(null)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      const scanId = crypto.randomUUID()
      const filePath = `${user.id}/${scanId}/${file.name}`

      // Upload to storage
      const { error: uploadError } = await supabase.storage
        .from('raw-scans')
        .upload(filePath, file)
      if (uploadError) throw uploadError

      // Create raw_scans record
      const { error: dbError } = await supabase.from('raw_scans').insert({
        id: scanId,
        filename: file.name,
        storage_path: filePath,
        status: 'pending',
      })
      if (dbError) throw dbError

      setStatus('processing')

      // Trigger orchestrator (non-blocking – Edge Function runs async)
      supabase.functions.invoke('process-upload', {
        body: { scanId, filePath, fileName: file.name },
      }).catch(err => console.warn('process-upload invoke error:', err))

      // Poll raw_scans every 2 seconds for live progress
      pollRef.current = setInterval(async () => {
        const { data } = await supabase
          .from('raw_scans')
          .select('status, page_count, pipeline_results, error_message')
          .eq('id', scanId)
          .single()

        if (!data) return

        if (data.page_count) setPageCount(data.page_count)
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

  return { uploadFile, status, pipelineResults, pageCount, stats, error, reset }
}
