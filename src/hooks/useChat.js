import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'

export function useChat(sessionId) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef(null)

  async function sendMessage(content) {
    const userMsg = { role: 'user', content, id: crypto.randomUUID() }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)

    const assistantId = crypto.randomUUID()
    setMessages(prev => [
      ...prev,
      { role: 'assistant', content: '', sources: [], id: assistantId, streaming: true }
    ])

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
            sessionId,
            query: content
          })
        }
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '))
        for (const line of lines) {
          const data = line.slice(6)
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data)
            if (parsed.text) {
              fullText += parsed.text
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: fullText } : m
              ))
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      // Resolve [[DOC:uuid]] markers
      const docMatches = [...fullText.matchAll(/\[\[DOC:([a-f0-9-]+)\]\]/g)]
      const docIds = [...new Set(docMatches.map(m => m[1]))]
      let sources = []
      if (docIds.length > 0) {
        const { data } = await supabase
          .from('knowledge_docs')
          .select('id, title, summary')
          .in('id', docIds)
        sources = data || []
      }

      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, streaming: false, sources } : m
      ))
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, content: 'Fehler beim Laden der Antwort. Bitte versuche es erneut.', streaming: false }
          : m
      ))
    } finally {
      setLoading(false)
    }
  }

  function clearMessages() {
    setMessages([])
  }

  return { messages, sendMessage, loading, clearMessages }
}
