import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useNotes(docId) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!docId) {
      setLoading(false)
      return
    }
    supabase
      .from('notes')
      .select('*')
      .eq('doc_id', docId)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setNotes(data || [])
        setLoading(false)
      })
  }, [docId])

  async function addNote(content) {
    const { data } = await supabase
      .from('notes')
      .insert({ doc_id: docId, content })
      .select()
      .single()
    if (data) setNotes(prev => [data, ...prev])
    return data
  }

  async function deleteNote(id) {
    await supabase.from('notes').delete().eq('id', id)
    setNotes(prev => prev.filter(n => n.id !== id))
  }

  return { notes, addNote, deleteNote, loading }
}
