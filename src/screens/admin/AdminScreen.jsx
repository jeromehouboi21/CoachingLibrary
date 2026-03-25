import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

export default function AdminScreen() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('idle') // idle | loading | success | error
  const [log, setLog] = useState([])
  const [errorMessage, setErrorMessage] = useState('')

  async function handleReset() {
    if (!password) return
    setStatus('loading')
    setLog([])
    setErrorMessage('')

    try {
      const { data, error } = await supabase.functions.invoke('admin-reset', {
        body: { password },
      })

      if (error) throw new Error(error.message)

      if (data?.error) {
        setErrorMessage(data.error)
        setStatus('error')
        return
      }

      setLog(data.log ?? [])
      setStatus('success')
      setPassword('')
    } catch (err) {
      setErrorMessage(err.message)
      setStatus('error')
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && password && status !== 'loading') handleReset()
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <button className="back-btn" onClick={() => navigate(-1)}>← Zurück</button>
        <h1 className="screen-title" style={{ marginTop: 12 }}>⚙️ Admin</h1>
        <p className="screen-subtitle">Beta-Test Verwaltung</p>
      </div>

      <div className="screen-content">
        <div className="card" style={{ borderLeft: '3px solid #c0392b' }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 8, color: 'var(--color-ink)' }}>
            🗑️ Alle Daten zurücksetzen
          </div>

          <p style={{ fontSize: '0.875rem', color: 'var(--color-ink-2)', marginBottom: 12 }}>
            Löscht vollständig:
          </p>
          <ul style={{
            fontSize: '0.875rem', color: 'var(--color-ink-2)',
            paddingLeft: 20, marginBottom: 20, lineHeight: 1.8,
          }}>
            <li>Alle Wissensdokumente (inkl. Chunks, Quellen, Notizen)</li>
            <li>Alle hochgeladenen Scans &amp; Seiten-Fingerprints</li>
            <li>Alle Storage-Dateien (PNGs)</li>
            <li>Gesamten Chat-Verlauf</li>
          </ul>

          <label style={{
            display: 'block', fontSize: '0.8125rem', fontWeight: 600,
            color: 'var(--color-ink-2)', marginBottom: 6,
          }}>
            Admin-Passwort
          </label>
          <input
            type="password"
            className="form-input"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Passwort eingeben"
            disabled={status === 'loading'}
            autoComplete="off"
            style={{ marginBottom: 14 }}
          />

          <button
            onClick={handleReset}
            disabled={!password || status === 'loading'}
            style={{
              width: '100%',
              padding: '12px 16px',
              background: !password || status === 'loading' ? 'rgba(192,57,43,0.3)' : '#c0392b',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              fontWeight: 600,
              fontSize: '0.9375rem',
              cursor: !password || status === 'loading' ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
            }}
          >
            {status === 'loading' ? (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <span className="spinner" style={{ width: 16, height: 16 }} />
                Wird zurückgesetzt…
              </span>
            ) : (
              'Alle Daten zurücksetzen'
            )}
          </button>

          {status === 'error' && (
            <div className="alert alert-error" style={{ marginTop: 14 }}>
              ✗ {errorMessage}
            </div>
          )}

          {status === 'success' && (
            <div style={{
              marginTop: 14, padding: '14px 16px',
              background: 'rgba(45,122,94,0.08)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(45,122,94,0.25)',
            }}>
              <div style={{ fontWeight: 600, color: '#2D7A5E', marginBottom: 8, fontSize: '0.9375rem' }}>
                ✓ Reset erfolgreich
              </div>
              {log.map((line, i) => (
                <div key={i} style={{
                  fontSize: '0.8125rem', color: 'var(--color-ink-2)',
                  paddingTop: 4, borderTop: i > 0 ? '1px solid var(--color-border)' : 'none',
                  marginTop: i > 0 ? 4 : 0,
                }}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
