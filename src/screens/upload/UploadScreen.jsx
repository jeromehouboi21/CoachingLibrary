import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUpload } from '../../hooks/useUpload'

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']
const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

// ─── Sub-components ───────────────────────────────────────────────────────────

function FilePreview({ file }) {
  const isImage = file.type.startsWith('image/')
  const sizeMB = (file.size / 1024 / 1024).toFixed(1)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', background: 'var(--color-surface)',
      borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)',
    }}>
      <span style={{ fontSize: '2rem' }}>{isImage ? '🖼️' : '📄'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: '0.9375rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {file.name}
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--color-ink-3)' }}>
          {sizeMB} MB · {file.type.includes('pdf') ? 'PDF' : 'Bild'}
        </div>
      </div>
    </div>
  )
}

const STATUS_ICON = {
  created: '✅',
  merged: '🔀',
  duplicate: '⭐',
  error: '❌',
  processing: '⏳',
}

const STATUS_LABEL = {
  created: 'Neu erstellt',
  merged: 'Gemergt',
  duplicate: 'Duplikat',
  error: 'Fehler',
  processing: 'In Bearbeitung',
}

function PipelineProgress({ status, convertProgress, uploadProgress, pageCount, pipelineResults, stats }) {
  const groupsTotal = pipelineResults.length
  const groupsDone = stats.done

  const convertDone = status !== 'converting'
  const uploadDone = status !== 'converting' && status !== 'uploading'
  const processingDone = status === 'done'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Phase overview */}
      <div style={{
        background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
        padding: '16px', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: 12, color: 'var(--color-ink)' }}>
          {status === 'converting' && 'PDF wird konvertiert…'}
          {status === 'uploading' && 'Seiten werden hochgeladen…'}
          {status === 'processing' && 'KI-Verarbeitung läuft'}
          {pageCount > 0 && <span style={{ fontWeight: 400, color: 'var(--color-ink-3)', marginLeft: 6 }}>· {pageCount} Seiten</span>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ProgressRow
            label="Phase 1 · Konvertierung"
            value={convertProgress.total > 0
              ? `${convertProgress.current}/${convertProgress.total}`
              : convertDone ? '✓' : '…'}
            done={convertDone}
          />
          <ProgressRow
            label="Phase 2 · Upload"
            value={uploadProgress.total > 0
              ? `${uploadProgress.current}/${uploadProgress.total}`
              : uploadDone ? '✓' : '…'}
            done={uploadDone}
          />
          <ProgressRow
            label="Phase 3 · Seiten analysiert (OCR + KI)"
            value={uploadDone && pageCount > 0 ? `${pageCount}/${pageCount}` : '…'}
            done={uploadDone && pageCount > 0 && groupsTotal > 0}
          />
          <ProgressRow
            label="Cluster erkannt"
            value={groupsTotal > 0 ? `${groupsTotal} Gruppe${groupsTotal !== 1 ? 'n' : ''}` : '…'}
            done={groupsTotal > 0}
          />
          <ProgressRow
            label="DB-Integration"
            value={groupsTotal > 0 ? `${groupsDone}/${groupsTotal}` : '…'}
            done={groupsDone > 0 && groupsDone === groupsTotal}
          />
        </div>
      </div>

      {/* Per-group results */}
      {pipelineResults.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-ink-2)', marginBottom: 8, paddingLeft: 4 }}>
            Ergebnisse
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pipelineResults.map((r, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: 'var(--color-surface)',
                borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)',
                opacity: r.status === 'processing' ? 0.6 : 1,
              }}>
                <span style={{ fontSize: '1.125rem', flexShrink: 0 }}>
                  {r.status === 'processing'
                    ? <span className="spinner" style={{ width: 16, height: 16, display: 'inline-block' }} />
                    : STATUS_ICON[r.status] || '❓'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.875rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.topic_label}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-ink-3)' }}>
                    {STATUS_LABEL[r.status] || r.status}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ textAlign: 'center', color: 'var(--color-ink-3)', fontSize: '0.8125rem' }}>
        Dieser Vorgang kann einige Minuten dauern…
      </div>
    </div>
  )
}

function ProgressRow({ label, value, done }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.875rem', color: done ? 'var(--color-accent)' : 'var(--color-ink-3)' }}>
          {done ? '✓' : <span className="spinner" style={{ width: 12, height: 12, display: 'inline-block' }} />}
        </span>
        <span style={{ fontSize: '0.875rem', color: 'var(--color-ink-2)' }}>{label}</span>
      </div>
      <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--color-ink)' }}>{value}</span>
    </div>
  )
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function UploadScreen() {
  const navigate = useNavigate()
  const { uploadFile, status, pipelineResults, convertProgress, uploadProgress, pageCount, stats, error, reset } = useUpload()
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileError, setFileError] = useState(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef(null)

  function validateFile(file) {
    if (!ACCEPTED_TYPES.includes(file.type)) return 'Nur PDF, JPEG und PNG Dateien sind erlaubt.'
    if (file.size > MAX_FILE_SIZE) return 'Die Datei darf maximal 50 MB groß sein.'
    return null
  }

  function handleFileSelect(file) {
    const err = validateFile(file)
    if (err) { setFileError(err); setSelectedFile(null) }
    else { setFileError(null); setSelectedFile(file) }
  }

  function handleInputChange(e) {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFileSelect(file)
  }, [])

  const handleDragOver = useCallback((e) => { e.preventDefault(); setIsDragOver(true) }, [])
  const handleDragLeave = useCallback(() => setIsDragOver(false), [])

  async function handleUpload() {
    if (!selectedFile) return
    await uploadFile(selectedFile)
  }

  function handleReset() {
    reset()
    setSelectedFile(null)
    setFileError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const isProcessing = status === 'converting' || status === 'uploading' || status === 'processing'

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Hochladen</h1>
        <p className="screen-subtitle">PDFs und Bilder verarbeiten</p>
      </div>

      <div className="screen-content">

        {/* ── Idle: drop zone ─────────────────────────────────────────────── */}
        {status === 'idle' && (
          <>
            <div
              className={`upload-zone ${isDragOver ? 'upload-zone--dragover' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              role="button"
              tabIndex={0}
              aria-label="Datei hochladen"
              onKeyDown={e => { if (e.key === 'Enter') fileInputRef.current?.click() }}
            >
              <div className="upload-zone__icon">{isDragOver ? '📂' : '⬆️'}</div>
              <div className="upload-zone__title">
                {isDragOver ? 'Loslassen zum Hochladen' : 'Datei auswählen oder hierher ziehen'}
              </div>
              <div className="upload-zone__hint">PDF, JPEG, PNG · Bis zu 50 MB</div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={handleInputChange}
              style={{ display: 'none' }}
            />

            {fileError && (
              <div className="alert alert-error" style={{ marginTop: 12 }}>{fileError}</div>
            )}

            {selectedFile && (
              <div style={{ marginTop: 16 }}>
                <FilePreview file={selectedFile} />
                <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={handleReset}>
                    Abbrechen
                  </button>
                  <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleUpload}>
                    🚀 Verarbeiten
                  </button>
                </div>
              </div>
            )}

            <div className="alert alert-info" style={{ marginTop: 20 }}>
              <strong>Wie funktioniert das?</strong><br />
              Die KI analysiert jede Seite einzeln, erkennt Themen, clustert verwandte Seiten und integriert neues Wissen intelligent in deine bestehende Bibliothek – auch seitenübergreifend.
            </div>
          </>
        )}

        {/* ── Processing: live pipeline progress ──────────────────────────── */}
        {isProcessing && (
          <>
            {selectedFile && (
              <div style={{ marginBottom: 16 }}>
                <FilePreview file={selectedFile} />
              </div>
            )}
            <PipelineProgress
              status={status}
              convertProgress={convertProgress}
              uploadProgress={uploadProgress}
              pageCount={pageCount}
              pipelineResults={pipelineResults}
              stats={stats}
            />
          </>
        )}

        {/* ── Done ────────────────────────────────────────────────────────── */}
        {status === 'done' && (
          <div>
            <div style={{
              textAlign: 'center', padding: '24px 16px',
              background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-sm)', marginBottom: 20,
            }}>
              <div style={{ fontSize: '3rem', marginBottom: 8 }}>✅</div>
              <h2 style={{ fontFamily: 'DM Serif Display, Georgia, serif', fontSize: '1.375rem', marginBottom: 8 }}>
                Verarbeitung abgeschlossen!
              </h2>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
                {stats.created > 0 && (
                  <StatPill icon="✅" value={stats.created} label="neu erstellt" />
                )}
                {stats.merged > 0 && (
                  <StatPill icon="🔀" value={stats.merged} label="gemergt" />
                )}
                {stats.duplicate > 0 && (
                  <StatPill icon="⭐" value={stats.duplicate} label="Duplikat" />
                )}
              </div>
            </div>

            {/* Detailed results */}
            {pipelineResults.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-ink-2)', marginBottom: 8, paddingLeft: 4 }}>
                  Alle Ergebnisse
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pipelineResults.map((r, i) => (
                    <div
                      key={i}
                      className={r.doc_id && r.status !== 'duplicate' ? 'card card--interactive' : 'card'}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}
                      onClick={() => { if (r.doc_id && r.status !== 'duplicate') navigate(`/doc/${r.doc_id}`) }}
                    >
                      <span style={{ fontSize: '1.125rem', flexShrink: 0 }}>{STATUS_ICON[r.status] || '❓'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.875rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.topic_label}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-ink-3)' }}>
                          {STATUS_LABEL[r.status] || r.status}
                        </div>
                      </div>
                      {r.doc_id && r.status !== 'duplicate' && (
                        <span style={{ color: 'var(--color-ink-3)', fontSize: '0.875rem' }}>›</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleReset}>
                Weitere Datei
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => navigate('/')}>
                Zur Bibliothek
              </button>
            </div>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────────────── */}
        {status === 'error' && (
          <div>
            <div style={{
              textAlign: 'center', padding: '24px 16px',
              background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-sm)', marginBottom: 20,
            }}>
              <div style={{ fontSize: '3rem', marginBottom: 8 }}>❌</div>
              <h2 style={{ fontFamily: 'DM Serif Display, Georgia, serif', fontSize: '1.375rem', marginBottom: 8 }}>
                Verarbeitung fehlgeschlagen
              </h2>
              <p style={{ color: 'var(--color-ink-2)', fontSize: '0.9375rem' }}>{error}</p>
            </div>
            <button className="btn btn-primary w-full" onClick={handleReset}>
              Erneut versuchen
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function StatPill({ icon, value, label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', background: 'var(--color-accent-light)',
      borderRadius: 'var(--radius-full)', fontSize: '0.875rem',
    }}>
      <span>{icon}</span>
      <strong>{value}</strong>
      <span style={{ color: 'var(--color-ink-2)' }}>{label}</span>
    </div>
  )
}
