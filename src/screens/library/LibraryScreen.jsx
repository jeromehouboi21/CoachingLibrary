import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLibrary } from '../../hooks/useLibrary'
import { supabase } from '../../lib/supabase'

const CATEGORIES = [
  'Alle',
  'Grundlagen',
  'Methoden',
  'Theorie',
  'Übungen',
  'Kommunikation',
  'Systemtheorie',
  'Aufstellungsarbeit',
  'Selbstreflexion',
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

function DocCard({ doc, onClick, onDelete }) {
  const [hovered, setHovered] = useState(false)

  function handleDelete(e) {
    e.stopPropagation()
    const confirmed = window.confirm(
      `"${doc.title}" dauerhaft löschen?\n\nAlle Notizen werden ebenfalls entfernt.`
    )
    if (confirmed) onDelete(doc.id, doc.title)
  }

  return (
    <div
      className="card card--interactive"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative' }}
    >
      {(hovered) && (
        <button
          onClick={handleDelete}
          title="Löschen"
          style={{
            position: 'absolute', top: 8, right: 8,
            background: 'rgba(192,57,43,0.1)', border: 'none',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            width: 28, height: 28, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '0.875rem', color: '#c0392b',
            zIndex: 1,
          }}
        >
          🗑️
        </button>
      )}
      <div className="card-title" style={{ paddingRight: 32 }}>{doc.title}</div>
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
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function LibraryScreen() {
  const navigate = useNavigate()
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [totalCount, setTotalCount] = useState(null)
  const [deletedIds, setDeletedIds] = useState(new Set())

  async function handleDeleteDocument(docId) {
    const { error } = await supabase
      .from('knowledge_docs')
      .delete()
      .eq('id', docId)

    if (error) {
      console.error('Löschen fehlgeschlagen:', error.message)
      return
    }

    setDeletedIds(prev => new Set([...prev, docId]))
    setTotalCount(c => (c !== null ? c - 1 : c))
  }

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput)
    }, 400)
    return () => clearTimeout(timer)
  }, [searchInput])

  const { docs, loading, error } = useLibrary({
    category: selectedCategory,
    search: debouncedSearch
  })

  useEffect(() => {
    supabase
      .from('knowledge_docs')
      .select('id', { count: 'exact', head: true })
      .then(({ count }) => setTotalCount(count))
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 className="screen-title">Bibliothek</h1>
            {totalCount !== null && (
              <p className="screen-subtitle">{totalCount} Wissensdokumente</p>
            )}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={handleLogout} title="Abmelden"
            style={{ fontSize: '1.25rem' }}>
            🚪
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="search-wrapper">
            <span className="search-icon">🔍</span>
            <input
              type="search"
              className="search-input"
              placeholder="Dokumente durchsuchen..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              aria-label="Bibliothek durchsuchen"
            />
          </div>
        </div>
        <div className="chip-row" style={{ marginTop: 12 }}>
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              className={`chip ${(cat === 'Alle' && !selectedCategory) || selectedCategory === cat ? 'chip-active' : ''}`}
              onClick={() => setSelectedCategory(cat === 'Alle' ? null : cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="screen-content">
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            Fehler beim Laden: {error.message}
          </div>
        )}

        {loading ? (
          <div className="card-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">📖</div>
            <div className="empty-state__title">
              {debouncedSearch || selectedCategory
                ? 'Keine Ergebnisse'
                : 'Bibliothek ist leer'}
            </div>
            <p className="empty-state__text">
              {debouncedSearch || selectedCategory
                ? 'Versuche einen anderen Suchbegriff oder eine andere Kategorie.'
                : 'Lade deine ersten Coaching-Materialien hoch, um loszulegen.'}
            </p>
            {!debouncedSearch && !selectedCategory && (
              <button
                className="btn btn-primary"
                style={{ marginTop: 8 }}
                onClick={() => navigate('/upload')}
              >
                ⬆️ Hochladen
              </button>
            )}
          </div>
        ) : (
          <div className="card-grid">
            {docs.filter(doc => !deletedIds.has(doc.id)).map(doc => (
              <DocCard
                key={doc.id}
                doc={doc}
                onClick={() => navigate(`/doc/${doc.id}`)}
                onDelete={handleDeleteDocument}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
