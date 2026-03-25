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

  const reprocessScan = useCallback(async (scanId) => {
    setReprocessing(true)
    setReprocessError(null)

    try {
      const { error: err } = await supabase.functions.invoke('reprocess-pages', {
        body: { scanId },
      })
      if (err) throw new Error(err.message)
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
      const { error: err } = await supabase.functions.invoke('reprocess-pages', {
        body: {},
      })
      if (err) throw new Error(err.message)
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
