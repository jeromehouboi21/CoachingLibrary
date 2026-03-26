import { useState, useCallback, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

export function useProcessing() {
  const [scans, setScans] = useState([])
  const [loading, setLoading] = useState(true)
  const [rerunning, setRerunning] = useState(null) // scanId being rerun, or 'all'

  // Filter state
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState(null)
  const [dateTo, setDateTo] = useState(null)

  const autoRefreshRef = useRef(null)

  const loadScans = useCallback(async (filters = {}) => {
    setLoading(true)

    const appliedStatusFilter = filters.statusFilter ?? statusFilter
    const appliedDateFrom = filters.dateFrom ?? dateFrom
    const appliedDateTo = filters.dateTo ?? dateTo

    try {
      let query = supabase
        .from('raw_scans')
        .select(`
          id,
          filename,
          upload_date,
          page_count,
          status,
          error_message,
          pipeline_results,
          page_hashes (
            id,
            page_number,
            status,
            error_message,
            doc_id
          )
        `)
        .order('upload_date', { ascending: false })
        .limit(50)

      if (appliedDateFrom) query = query.gte('upload_date', appliedDateFrom)
      if (appliedDateTo)   query = query.lte('upload_date', appliedDateTo + 'T23:59:59')

      const { data, error } = await query
      if (error) throw error

      const enriched = (data || []).map(scan => {
        const hashes = scan.page_hashes || []
        const processedCount = hashes.filter(h => h.status === 'processed').length
        const errorCount     = hashes.filter(h => h.status === 'error').length
        const pendingCount   = hashes.filter(h =>
          ['uploaded', 'processing', 'ocr_complete'].includes(h.status) && !h.doc_id
        ).length
        const isFullyDone = scan.page_count > 0
          && processedCount === scan.page_count
          && errorCount === 0
          && pendingCount === 0

        return {
          ...scan,
          processedCount,
          errorCount,
          pendingCount,
          isFullyDone,
          pages: hashes.slice().sort((a, b) => a.page_number - b.page_number),
        }
      })

      const filtered = enriched.filter(scan => {
        if (appliedStatusFilter === 'all')        return true
        if (appliedStatusFilter === 'done')       return scan.isFullyDone
        if (appliedStatusFilter === 'error')      return scan.errorCount > 0
        if (appliedStatusFilter === 'pending')    return scan.pendingCount > 0
        if (appliedStatusFilter === 'processing') return scan.status === 'processing'
        return true
      })

      setScans(filtered)
    } catch (err) {
      console.error('[useProcessing] loadScans:', err.message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, dateFrom, dateTo])

  // Auto-refresh every 3 sec when any scan is actively processing
  useEffect(() => {
    const hasProcessing = scans.some(s => s.status === 'processing')

    if (hasProcessing && !autoRefreshRef.current) {
      autoRefreshRef.current = setInterval(() => loadScans(), 3000)
    } else if (!hasProcessing && autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current)
      autoRefreshRef.current = null
    }

    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current)
        autoRefreshRef.current = null
      }
    }
  }, [scans, loadScans])

  async function rerunScan(scanId) {
    setRerunning(scanId)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const authHeader = { Authorization: `Bearer ${session?.access_token}` }

      // Find failed/stuck page hashes for this scan
      const { data: failedHashes } = await supabase
        .from('page_hashes')
        .select('page_number')
        .eq('scan_id', scanId)
        .in('status', ['error', 'uploaded', 'processing', 'ocr_complete'])
        .is('doc_id', null)

      if (!failedHashes || failedHashes.length === 0) return

      const pageFilenames = failedHashes.map(h =>
        `page_${String(h.page_number).padStart(3, '0')}.png`
      )

      // Reset page hash statuses
      for (const h of failedHashes) {
        await supabase.from('page_hashes').update({
          status: 'uploaded',
          error_message: null,
          ocr_text: null,
          analysis: null,
          doc_id: null,
        }).eq('scan_id', scanId).eq('page_number', h.page_number)
      }

      // Reset scan status and clear previous results
      await supabase.from('raw_scans')
        .update({ status: 'pending', ocr_results: null, cluster_groups: null })
        .eq('id', scanId)

      // Phase 1: OCR + analysis
      const { error: ocrError } = await supabase.functions.invoke('process-ocr', {
        body: { scanId, pageFilenames },
        headers: authHeader,
      })
      if (ocrError) throw new Error(`OCR fehlgeschlagen: ${ocrError.message}`)

      // Phase 2: Clustering — backend self-orchestrates all batches
      const { error: clusterError } = await supabase.functions.invoke('process-cluster', {
        body: { scanId, startIndex: 0, batchSize: 3 },
        headers: authHeader,
      })
      if (clusterError) throw new Error(`Clustering fehlgeschlagen: ${clusterError.message}`)

      await loadScans()
    } catch (err) {
      console.error('[useProcessing] rerunScan:', err.message)
    } finally {
      setRerunning(null)
    }
  }

  async function rerunAll() {
    setRerunning('all')
    try {
      const failedScans = scans.filter(s => !s.isFullyDone)
      for (const scan of failedScans) {
        await rerunScan(scan.id)
      }
    } finally {
      setRerunning(null)
    }
  }

  function applyFilters() {
    loadScans()
  }

  return {
    scans,
    loading,
    rerunning,
    statusFilter, setStatusFilter,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    loadScans,
    applyFilters,
    rerunScan,
    rerunAll,
  }
}
