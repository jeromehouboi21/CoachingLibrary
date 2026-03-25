import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProcessing } from '../../hooks/useProcessing'

const STATUS_LABEL = {
  converting: 'Konvertierung',
  uploading: 'Upload',
  processing: 'Verarbeitung',
  ocr_complete: 'OCR abgeschlossen',
  clustering: 'Clustering',
  processed: 'Fertig',
  error: 'Fehler',
}

const STATUS_COLOR = {
  processed: 'var(--color-success, #2D7A5E)',
  error: '#c0392b',
  ocr_complete: 'var(--color-ink-2)',
  processing: 'var(--color-ink-3)',
  converting: 'var(--color-ink-3)',
  uploading: 'var(--color-ink-3)',
  clustering: 'var(--color-ink-2)',
}

function StatusBadge({ status }) {
  return (
    <span style={{
      fontSize: '0.75rem',
      fontWeight: 600,
      color: STATUS_COLOR[status] || 'var(--color-ink-3)',
      background: 'rgba(0,0,0,0.06)',
      padding: '2px 8px',
      borderRadius: 999,
      whiteSpace: 'nowrap',
    }}>
      {STATUS_LABEL[status] || status}
    </span>
  )
}

function PageStatusRow({ page }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '4px 0',
      fontSize: '0.8125rem',
      color: 'var(--color-ink-2)',
    }}>
      <span>Seite {page.page_number}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusBadge status={page.status} />
        {page.doc_id && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-success, #2D7A5E)' }}>✓</span>
        )}
      </div>
    </div>
  )
}

function ScanCard({ scan, onReprocess, reprocessing }) {
  const pageHashes = scan.page_hashes || []
  const failedPages = pageHashes.filter(p => p.status === 'error' || (p.status !== 'processed' && !p.doc_id))
  const hasFailures = failedPages.length > 0

  const uploadDate = scan.upload_date
    ? new Date(scan.upload_date).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
    : ''

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 600,
            fontSize: '0.9375rem',
            color: 'var(--color-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {scan.filename}
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-ink-3)', marginTop: 2 }}>
            {uploadDate} · {scan.page_count ?? pageHashes.length} Seiten
          </div>
          {scan.error_message && (
            <div style={{ fontSize: '0.8125rem', color: '#c0392b', marginTop: 4 }}>
              {scan.error_message}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <StatusBadge status={scan.status} />
          {hasFailures && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onReprocess(scan.id)}
              disabled={reprocessing}
              style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}
            >
              {reprocessing ? 'Läuft...' : '↻ Wiederholen'}
            </button>
          )}
        </div>
      </div>

      {pageHashes.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
          {pageHashes
            .slice()
            .sort((a, b) => a.page_number - b.page_number)
            .map(page => (
              <PageStatusRow key={page.id} page={page} />
            ))}
        </div>
      )}
    </div>
  )
}

export default function ProcessingScreen() {
  const navigate = useNavigate()
  const {
    scans,
    loading,
    error,
    reprocessing,
    reprocessError,
    loadScans,
    reprocessScan,
    reprocessAll,
  } = useProcessing()

  useEffect(() => {
    loadScans()
  }, [loadScans])

  const hasAnyFailures = scans.some(scan => {
    const pages = scan.page_hashes || []
    return pages.some(p => p.status === 'error' || (p.status !== 'processed' && !p.doc_id))
  })

  return (
    <div className="screen">
      <div className="screen-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button className="back-btn" onClick={() => navigate(-1)}>← Zurück</button>
          {hasAnyFailures && (
            <button
              className="btn btn-primary btn-sm"
              onClick={reprocessAll}
              disabled={reprocessing}
            >
              {reprocessing ? 'Läuft...' : '↻ Alle wiederholen'}
            </button>
          )}
        </div>
        <h1 className="screen-title" style={{ marginTop: 12 }}>Verarbeitungsstatus</h1>
        <p className="screen-subtitle">Upload-Verlauf und fehlgeschlagene Seiten</p>
      </div>

      <div className="screen-content">
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            Fehler beim Laden: {error}
          </div>
        )}
        {reprocessError && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            Fehler beim Wiederholen: {reprocessError}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton-card">
                <div className="skeleton skeleton-line skeleton-line--title" style={{ marginBottom: 8 }} />
                <div className="skeleton skeleton-line skeleton-line--short" />
              </div>
            ))}
          </div>
        ) : scans.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">📂</div>
            <div className="empty-state__title">Keine Uploads vorhanden</div>
            <p className="empty-state__text">Noch keine Dateien hochgeladen.</p>
            <button
              className="btn btn-primary"
              style={{ marginTop: 8 }}
              onClick={() => navigate('/upload')}
            >
              ⬆️ Hochladen
            </button>
          </div>
        ) : (
          scans.map(scan => (
            <ScanCard
              key={scan.id}
              scan={scan}
              onReprocess={reprocessScan}
              reprocessing={reprocessing}
            />
          ))
        )}
      </div>
    </div>
  )
}
