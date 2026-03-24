import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useLibrary({ category = null, search = '' } = {}) {
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function fetchDocs() {
      setLoading(true)
      setError(null)
      let query = supabase
        .from('knowledge_docs')
        .select('id, title, summary, category, subcategory, tags, difficulty, created_at')
        .order('created_at', { ascending: false })

      if (category) query = query.eq('category', category)
      if (search) query = query.or(`title.ilike.%${search}%,summary.ilike.%${search}%`)

      const { data, error } = await query
      if (error) setError(error)
      else setDocs(data || [])
      setLoading(false)
    }
    fetchDocs()
  }, [category, search])

  return { docs, loading, error }
}
