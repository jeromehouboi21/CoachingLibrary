import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useNotes } from '../../hooks/useNotes'

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

function getDifficultyColor(difficulty) {
  const map = {
    'Grundlagen': '#2D7A5E',
    'Fortgeschritten': '#B79A3A',
    'Experten': '#B74A3A',
  }
  return map[difficulty] || 'var(--color-ink-3)'
}

function NoteModal({ docId, onClose, onSaved }) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const { addNote } = useNotes(docId)

  async function handleSave() {
    if (!content.trim()) return
    setSaving(true)
    await addNote(content.trim())
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-sheet">
        <div className="modal-handle" />
        <h3 className="modal-title">Notiz hinzufügen</h3>
        <textarea
          className="form-textarea"
          placeholder="Deine Notiz..."
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={5}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={handleSave}
            disabled={!content.trim() || saving}
          >
            {saving ? 'Speichern...' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
}

export default function DocumentScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [doc, setDoc] = useState(null)
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showNoteModal, setShowNoteModal] = useState(false)
  const [notesKey, setNotesKey] = useState(0)

  const { notes, deleteNote, loading: notesLoading } = useNotes(id)

  useEffect(() => {
    async function fetchDoc() {
      setLoading(true)
      const { data, error } = await supabase
        .from('knowledge_docs')
        .select('*')
        .eq('id', id)
        .single()

      if (error) {
        setError(error.message)
      } else {
        setDoc(data)
        // Fetch sources
        const { data: srcData } = await supabase
          .from('doc_sources')
          .select('id, filename, pages, scan_id, raw_scans(id, filename, upload_date)')
          .eq('doc_id', id)
        setSources(srcData || [])
      }
      setLoading(false)
    }
    fetchDoc()
  }, [id])

  if (loading) {
    return (
      <div className="screen">
        <div className="screen-header">
          <button className="back-btn" onClick={() => navigate(-1)}>
            ← Zurück
          </button>
        </div>
        <div className="screen-content">
          <div className="skeleton skeleton-line skeleton-line--title" style={{ height: 28, width: '70%', marginBottom: 16 }} />
          <div className="skeleton skeleton-line" style={{ width: '100%', marginBottom: 8 }} />
          <div className="skeleton skeleton-line" style={{ width: '90%', marginBottom: 8 }} />
          <div className="skeleton skeleton-line" style={{ width: '80%' }} />
        </div>
      </div>
    )
  }

  if (error || !doc) {
    return (
      <div className="screen">
        <div className="screen-header">
          <button className="back-btn" onClick={() => navigate(-1)}>← Zurück</button>
        </div>
        <div className="screen-content">
          <div className="empty-state">
            <div className="empty-state__icon">⚠️</div>
            <div className="empty-state__title">Dokument nicht gefunden</div>
            <p className="empty-state__text">{error || 'Dieses Dokument existiert nicht mehr.'}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <button className="back-btn" onClick={() => navigate(-1)}>← Zurück</button>
        {doc.category && doc.subcategory && (
          <div className="breadcrumb" style={{ marginTop: 4 }}>
            <span>{doc.category}</span>
            <span className="breadcrumb__sep">›</span>
            <span style={{ color: 'var(--color-ink-2)' }}>{doc.subcategory}</span>
          </div>
        )}
      </div>

      <div className="screen-content">
        {/* Title & Meta */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontFamily: 'DM Serif Display, Georgia, serif', fontSize: '1.75rem', lineHeight: 1.2, marginBottom: 12 }}>
            {doc.title}
          </h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            {doc.category && (
              <span className={`badge ${getCategoryClass(doc.category)}`}>{doc.category}</span>
            )}
            {doc.difficulty && (
              <span style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: getDifficultyColor(doc.difficulty),
                background: 'rgba(0,0,0,0.05)',
                padding: '3px 9px',
                borderRadius: 999,
              }}>
                {doc.difficulty}
              </span>
            )}
          </div>
          {doc.summary && (
            <p style={{ fontSize: '0.9375rem', color: 'var(--color-ink-2)', lineHeight: 1.65, marginBottom: 12 }}>
              {doc.summary}
            </p>
          )}
          {doc.tags && doc.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {doc.tags.map(tag => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          )}
        </div>

        <div className="divider" />

        {/* Content */}
        {doc.content_html ? (
          <div
            className="doc-content"
            dangerouslySetInnerHTML={{ __html: doc.content_html }}
          />
        ) : doc.content_text ? (
          <div className="doc-content">
            {doc.content_text.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        ) : (
          <div className="empty-state" style={{ padding: '24px 0' }}>
            <div className="empty-state__icon">📄</div>
            <p className="empty-state__text">Kein Inhalt verfügbar.</p>
          </div>
        )}

        {/* Sources */}
        {sources.length > 0 && (
          <>
            <div className="divider" />
            <div>
              <div className="section-header">
                <h3 className="section-title">Quellen</h3>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sources.map(src => (
                  <div key={src.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    background: 'var(--color-surface)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-sm)',
                    fontSize: '0.875rem',
                  }}>
                    <span style={{ fontSize: '1.25rem' }}>📎</span>
                    <div>
                      <div style={{ fontWeight: 500, color: 'var(--color-ink)' }}>
                        {src.filename || src.raw_scans?.filename || 'Unbekannte Datei'}
                      </div>
                      {src.pages && src.pages.length > 0 && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-ink-3)' }}>
                          Seiten: {src.pages.join(', ')}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Notes */}
        <div className="divider" />
        <div>
          <div className="section-header">
            <h3 className="section-title">Notizen</h3>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowNoteModal(true)}
            >
              + Notiz
            </button>
          </div>

          {notesLoading ? (
            <div style={{ color: 'var(--color-ink-3)', fontSize: '0.875rem' }}>Laden...</div>
          ) : notes.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '24px 16px',
              color: 'var(--color-ink-3)',
              fontSize: '0.875rem',
            }}>
              Noch keine Notizen. Füge deine ersten Gedanken hinzu.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {notes.map(note => (
                <div key={note.id} className="note-card">
                  <button
                    className="note-delete-btn"
                    onClick={() => deleteNote(note.id)}
                    title="Notiz löschen"
                  >
                    ✕
                  </button>
                  <div className="note-card__content">{note.content}</div>
                  <div className="note-card__date">{formatDate(note.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ paddingBottom: 24 }} />
      </div>

      {showNoteModal && (
        <NoteModal
          docId={id}
          onClose={() => setShowNoteModal(false)}
          onSaved={() => setNotesKey(k => k + 1)}
        />
      )}
    </div>
  )
}
