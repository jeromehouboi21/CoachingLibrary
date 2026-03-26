import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProcessing } from '../../hooks/useProcessing'

// ─── Status icons & labels ────────────────────────────────────────────────────

function pageStatusIcon(status) {
  if (status === 'processed') return '✅'
  if (status === 'error') return '❌'
  return '⏳'
}

function ScanStatusSummary({ scan }) {
  const parts = []
  if (scan.processedCount > 0) parts.push(`✅ ${scan.processedCount}`)
  if (scan.errorCount > 0)     parts.push(`❌ ${scan.errorCount}`)
  if (scan.pendingCount > 0)   parts.push(`⏳ ${scan.pendingCount}`)
  if (scan.isFullyDone)        return <span style={{ fontSize: '0.8125rem', color: 'var(--color-success, #2D7A5E)' }}>✅ vollständig verarbeitet</span>
  return <span style={{ fontSize: '0.8125rem', color: 'var(--color-ink-3)' }}>{parts.join('  ')}</span>
}

// ─── Scan card ────────────────────────────────────────────────────────────────

function ScanCard({ scan, expanded, onToggle, onRerun, rerunning }) {
  const isRerunning = rerunning === scan.id || rerunning === 'all'

  const uploadDate = scan.upload_date
    ? new Date(scan.upload_date).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : ''

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 600, fontSize: '0.9375rem', color: 'var(--color-ink)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            📄 {scan.filename}
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-ink-3)', marginTop: 2 }}>
            {uploadDate} · {scan.page_count ?? scan.pages.length} Seiten
          </div>
          <div style={{ marginTop: 4 }}>
            <ScanStatusSummary scan={scan} />
          </div>
          {scan.error_message && (
            <div style={{ fontSize: '0.75rem', color: '#c0392b', marginTop: 4 }}>
              {scan.error_message}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {!scan.isFullyDone && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onRerun(scan.id)}
              disabled={!!rerunning}
              style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}
            >
              {isRerunning ? 'Läuft…' : '↻ Erneut'}
            </button>
          )}
          <button
            onClick={onToggle}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--color-ink-3)', fontSize: '1rem', padding: '4px',
            }}
            aria-label={expanded ? 'Einklappen' : 'Aufklappen'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Expandable page list */}
      {expanded && scan.pages.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
          {scan.pages.map(page => (
            <div
              key={page.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '4px 0', fontSize: '0.8125rem', color: 'var(--color-ink-2)',
              }}
            >
              <span>Seite {page.page_number}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{pageStatusIcon(page.status)}</span>
                {page.error_message && (
                  <span
                    style={{ fontSize: '0.75rem', color: '#c0392b', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={page.error_message}
                  >
                    {page.error_message}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ProcessingScreen() {
  const navigate = useNavigate()
  const {
    scans, loading, rerunning,
    statusFilter, setStatusFilter,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    loadScans, applyFilters,
    rerunScan, rerunAll,
  } = useProcessing()

  const [expandedScans, setExpandedScans] = useState(new Set())

  useEffect(() => {
    loadScans()
  }, [loadScans])

  function toggleExpand(scanId) {
    setExpandedScans(prev => {
      const next = new Set(prev)
      next.has(scanId) ? next.delete(scanId) : next.add(scanId)
      return next
    })
  }

  const hasAnyIncomplete = scans.some(s => !s.isFullyDone)

  return (
    <div className="screen">
      <div className="screen-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button className="back-btn" onClick={() => navigate(-1)}>← Zurück</button>
          {hasAnyIncomplete && (
            <button
              className="btn btn-primary btn-sm"
              onClick={rerunAll}
              disabled={!!rerunning}
            >
              {rerunning === 'all' ? 'Läuft…' : '↻ Alle ausstehenden'}
            </button>
          )}
        </div>
        <h1 className="screen-title" style={{ marginTop: 12 }}>Verarbeitungsübersicht</h1>
      </div>

      <div className="screen-content">
        {/* Filter bar */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16,
          padding: '12px', background: 'var(--color-surface)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)',
        }}>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ flex: '1 1 120px', fontSize: '0.875rem', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }}
          >
            <option value="all">Alle</option>
            <option value="done">Vollständig</option>
            <option value="error">Fehlerhaft</option>
            <option value="pending">Ausstehend</option>
            <option value="processing">In Bearbeitung</option>
          </select>

          <input
            type="date"
            value={dateFrom ?? ''}
            onChange={e => setDateFrom(e.target.value || null)}
            style={{ flex: '1 1 120px', fontSize: '0.875rem', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }}
          />
          <input
            type="date"
            value={dateTo ?? ''}
            onChange={e => setDateTo(e.target.value || null)}
            style={{ flex: '1 1 120px', fontSize: '0.875rem', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }}
          />

          <button
            className="btn btn-secondary btn-sm"
            onClick={applyFilters}
            style={{ flexShrink: 0 }}
          >
            Filter anwenden
          </button>
        </div>

        {/* Scan list */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            <div className="empty-state__title">Keine Uploads gefunden</div>
            <p className="empty-state__text">Keine Einträge für den gewählten Filter.</p>
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
              expanded={expandedScans.has(scan.id)}
              onToggle={() => toggleExpand(scan.id)}
              onRerun={rerunScan}
              rerunning={rerunning}
            />
          ))
        )}
      </div>
    </div>
  )
}
