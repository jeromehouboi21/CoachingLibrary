import { useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Hook for viewing upload history and reprocessing failed pages.
 */
export function useProcessing() {
  const [scans, setScans] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessError, setReprocessError] = useState(null)

  const loadScans = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const { data, error: err } = await supabase
        .from('raw_scans')
        .select(`
          id,
          filename,
          status,
          page_count,
          upload_date,
          error_message,
          page_hashes(id, page_number, status, error_message, doc_id)
        `)
        .order('upload_date', { ascending: false })
        .limit(50)

      if (err) throw err
      setScans(data || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  async function _reprocessAndCluster(body) {
    // Step 1: OCR + analyze failed pages
    const { data, error: err } = await supabase.functions.invoke('reprocess-pages', { body })
    if (err) throw new Error(err.message)

    // Step 2: Trigger clustering for each affected scan (with user JWT — avoids 401)
    const scanIds = data?.scanIds ?? []
    for (const scanId of scanIds) {
      const { error: clusterErr } = await supabase.functions.invoke('process-cluster', {
        body: { scanId },
      })
      if (clusterErr) {
        console.error(`process-cluster fehlgeschlagen für ${scanId}:`, clusterErr.message)
      }
    }
  }

  const reprocessScan = useCallback(async (scanId) => {
    setReprocessing(true)
    setReprocessError(null)

    try {
      await _reprocessAndCluster({ scanId })
      await loadScans()
    } catch (err) {
      setReprocessError(err.message)
    } finally {
      setReprocessing(false)
    }
  }, [loadScans])

  const reprocessAll = useCallback(async () => {
    setReprocessing(true)
    setReprocessError(null)

    try {
      await _reprocessAndCluster({})
      await loadScans()
    } catch (err) {
      setReprocessError(err.message)
    } finally {
      setReprocessing(false)
    }
  }, [loadScans])

  return {
    scans,
    loading,
    error,
    reprocessing,
    reprocessError,
    loadScans,
    reprocessScan,
    reprocessAll,
  }
}
