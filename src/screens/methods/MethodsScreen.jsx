import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

const METHOD_TAGS = [
  'Alle',
  'Systemaufstellung',
  'Befragung',
  'Feedback',
  'Visualisierung',
  'Rollenspiel',
  'Reflektion',
  'Gruppenarbeit',
  'Konflikt',
  'Kommunikation',
]

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

function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton skeleton-line skeleton-line--title" style={{ marginBottom: 10 }} />
      <div className="skeleton skeleton-line" style={{ width: '100%' }} />
      <div className="skeleton skeleton-line skeleton-line--short" />
      <div style={{ marginTop: 12 }}>
        <div className="skeleton skeleton-line" style={{ width: 60, height: 20, borderRadius: 999 }} />
      </div>
    </div>
  )
}

export default function MethodsScreen() {
  const navigate = useNavigate()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedTag, setSelectedTag] = useState(null)
  const [allTags, setAllTags] = useState([])

  useEffect(() => {
    async function fetchMethods() {
      setLoading(true)
      setError(null)

      const { data, error } = await supabase
        .from('knowledge_docs')
        .select('id, title, summary, category, subcategory, tags, difficulty, created_at')
        .or(
          `category.eq.Methoden,category.eq.Übungen,category.eq.Aufstellungsarbeit`
        )
        .order('created_at', { ascending: false })

      if (error) {
        setError(error.message)
      } else {
        setDocs(data || [])
        // Extract unique tags
        const tagSet = new Set()
        data?.forEach(doc => doc.tags?.forEach(t => tagSet.add(t)))
        setAllTags([...tagSet].sort())
      }
      setLoading(false)
    }
    fetchMethods()
  }, [])

  const filteredDocs = selectedTag
    ? docs.filter(doc => doc.tags?.includes(selectedTag))
    : docs

  const displayTags = allTags.length > 0 ? allTags : METHOD_TAGS.slice(1)

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Methoden</h1>
        <p className="screen-subtitle">Coaching-Werkzeuge & Übungen</p>
        <div className="chip-row" style={{ marginTop: 12 }}>
          <button
            className={`chip ${!selectedTag ? 'chip-active' : ''}`}
            onClick={() => setSelectedTag(null)}
          >
            Alle
          </button>
          {displayTags.map(tag => (
            <button
              key={tag}
              className={`chip ${selectedTag === tag ? 'chip-active' : ''}`}
              onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      <div className="screen-content">
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            Fehler beim Laden: {error}
          </div>
        )}

        {loading ? (
          <div className="card-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">🛠</div>
            <div className="empty-state__title">
              {selectedTag ? 'Keine Methoden gefunden' : 'Noch keine Methoden'}
            </div>
            <p className="empty-state__text">
              {selectedTag
                ? `Keine Dokumente mit dem Tag "${selectedTag}".`
                : 'Lade Coaching-Materialien hoch, um Methoden zu entdecken.'}
            </p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 12, fontSize: '0.875rem', color: 'var(--color-ink-3)' }}>
              {filteredDocs.length} {filteredDocs.length === 1 ? 'Methode' : 'Methoden'}
              {selectedTag && ` mit Tag "${selectedTag}"`}
            </div>
            <div className="card-grid">
              {filteredDocs.map(doc => (
                <div
                  key={doc.id}
                  className="card card--interactive"
                  onClick={() => navigate(`/doc/${doc.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') navigate(`/doc/${doc.id}`) }}
                >
                  <div className="card-title">{doc.title}</div>
                  {doc.summary && (
                    <div className="card-summary">{doc.summary}</div>
                  )}
                  <div className="card-footer">
                    {doc.category && (
                      <span className={`badge ${getCategoryClass(doc.category)}`}>
                        {doc.category}
                      </span>
                    )}
                    {doc.difficulty && (
                      <span className="tag">{doc.difficulty}</span>
                    )}
                  </div>
                  {doc.tags && doc.tags.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {doc.tags.slice(0, 3).map(tag => (
                        <span
                          key={tag}
                          className={`tag ${selectedTag === tag ? 'chip chip-active' : ''}`}
                          style={selectedTag === tag ? { padding: '2px 8px', fontSize: '0.6875rem' } : {}}
                          onClick={e => {
                            e.stopPropagation()
                            setSelectedTag(tag === selectedTag ? null : tag)
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
