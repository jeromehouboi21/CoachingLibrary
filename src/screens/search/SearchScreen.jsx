import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

function getCategoryClass(category) {
  const map = {
    'Grundlagen': 'badge-grundlagen',
    'Methoden': 'badge-methoden',
    'Theorie': 'badge-theorie',
    'Übungen': 'badge-ubungen',
    'Kommunikation': 'badge-kommunikation',
    'Systemtheorie': 'badge-systemtheorie',
    'Aufstellungsarbeit': 'badge-aufstellungsarbeit',
    'Selbstreflexion': 'badge-selbstreflexion',
  }
  return map[category] || 'badge-default'
}

function highlightText(text, query) {
  if (!query || !text) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i}>{part}</mark>
      : part
  )
}

function SearchResult({ doc, query, excerpt, onClick }) {
  return (
    <div className="search-result" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onClick() }}>
      <div className="search-result__title">
        {highlightText(doc.title, query)}
      </div>
      {(excerpt || doc.summary) && (
        <div className="search-result__excerpt">
          {highlightText((excerpt || doc.summary || '').slice(0, 200), query)}
          {(excerpt || doc.summary || '').length > 200 ? '…' : ''}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {doc.category && (
          <span className={`badge ${getCategoryClass(doc.category)}`}>{doc.category}</span>
        )}
        {doc.tags && doc.tags.slice(0, 2).map(tag => (
          <span key={tag} className="tag">{tag}</span>
        ))}
      </div>
    </div>
  )
}

export default function SearchScreen() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('volltext') // 'volltext' | 'semantisch'
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [searched, setSearched] = useState(false)

  // Debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query)
    }, 400)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults([])
      setSearched(false)
      return
    }
    performSearch(debouncedQuery)
  }, [debouncedQuery, mode])

  async function performSearch(q) {
    setLoading(true)
    setError(null)
    setSearched(true)

    try {
      if (mode === 'volltext') {
        const { data, error } = await supabase
          .from('knowledge_docs')
          .select('id, title, summary, category, subcategory, tags, difficulty')
          .or(`title.ilike.%${q}%,summary.ilike.%${q}%,content_text.ilike.%${q}%`)
          .order('created_at', { ascending: false })
          .limit(20)

        if (error) throw error
        setResults((data || []).map(doc => ({ ...doc, excerpt: null, similarity: null })))
      } else {
        // Semantic search via Edge Function
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/semantic-search`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ query: q })
          }
        )

        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        setResults(data.results || [])
      }
    } catch (err) {
      setError(err.message)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Suche</h1>

        {/* Mode toggle */}
        <div style={{
          display: 'flex',
          background: 'var(--color-surface)',
          borderRadius: 'var(--radius-full)',
          padding: 3,
          gap: 2,
          marginTop: 8,
          boxShadow: 'var(--shadow-sm)',
          width: 'fit-content',
        }}>
          {['volltext', 'semantisch'].map(m => (
            <button
              key={m}
              onClick={() => {
                setMode(m)
                setResults([])
                setSearched(false)
              }}
              style={{
                padding: '7px 18px',
                borderRadius: 'var(--radius-full)',
                fontSize: '0.875rem',
                fontWeight: 500,
                background: mode === m ? 'var(--color-accent)' : 'transparent',
                color: mode === m ? '#ffffff' : 'var(--color-ink-2)',
                transition: 'all 150ms ease',
              }}
            >
              {m === 'volltext' ? 'Volltext' : '✨ Semantisch'}
            </button>
          ))}
        </div>

        <div className="search-wrapper" style={{ marginTop: 10 }}>
          <span className="search-icon">🔍</span>
          <input
            type="search"
            className="search-input"
            placeholder={mode === 'volltext' ? 'Suchbegriff eingeben...' : 'Frage oder Konzept...'}
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
            aria-label="Suche"
          />
        </div>
      </div>

      <div className="screen-content">
        {mode === 'semantisch' && !searched && !query && (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            <strong>Semantische Suche</strong><br />
            Beschreibe, was du suchst – z.B. "Techniken für schwierige Gespräche" – und die KI findet die relevantesten Dokumente.
          </div>
        )}

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            Suchfehler: {error}
          </div>
        )}

        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton-card" style={{ padding: 14 }}>
                <div className="skeleton skeleton-line skeleton-line--title" style={{ marginBottom: 8 }} />
                <div className="skeleton skeleton-line" style={{ width: '100%', marginBottom: 6 }} />
                <div className="skeleton skeleton-line" style={{ width: '70%' }} />
              </div>
            ))}
          </div>
        )}

        {!loading && searched && results.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__icon">🔍</div>
            <div className="empty-state__title">Keine Ergebnisse</div>
            <p className="empty-state__text">
              Für "{debouncedQuery}" wurden keine Dokumente gefunden.
              {mode === 'volltext' && ' Versuche die semantische Suche für bessere Ergebnisse.'}
            </p>
          </div>
        )}

        {!loading && results.length > 0 && (
          <>
            <div style={{ marginBottom: 12, fontSize: '0.875rem', color: 'var(--color-ink-3)' }}>
              {results.length} {results.length === 1 ? 'Ergebnis' : 'Ergebnisse'}
              {mode === 'semantisch' && ' (nach Relevanz sortiert)'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {results.map(result => (
                <SearchResult
                  key={result.id}
                  doc={result}
                  query={debouncedQuery}
                  excerpt={result.excerpt}
                  onClick={() => navigate(`/doc/${result.id}`)}
                />
              ))}
            </div>
          </>
        )}

        {!query && !loading && !searched && (
          <div className="empty-state">
            <div className="empty-state__icon">💡</div>
            <div className="empty-state__title">Was suchst du?</div>
            <p className="empty-state__text">
              Gib einen Begriff oder eine Frage ein, um deine Coaching-Bibliothek zu durchsuchen.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
