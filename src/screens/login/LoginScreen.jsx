import { useState } from 'react'
import { supabase } from '../../lib/supabase'

export default function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [successMsg, setSuccessMsg] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccessMsg(null)

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setSuccessMsg('Registrierung erfolgreich! Bitte überprüfe deine E-Mail zur Bestätigung.')
      }
    } catch (err) {
      const messages = {
        'Invalid login credentials': 'Ungültige E-Mail oder Passwort.',
        'Email not confirmed': 'Bitte bestätige zuerst deine E-Mail-Adresse.',
        'User already registered': 'Diese E-Mail ist bereits registriert.',
        'Password should be at least 6 characters': 'Das Passwort muss mindestens 6 Zeichen haben.',
      }
      setError(messages[err.message] || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-logo">📚 Coaching Bibliothek</div>
      <p className="login-tagline">Deine persönliche KI-Wissensbasis</p>

      <div className="login-card">
        <h2>{mode === 'login' ? 'Anmelden' : 'Registrieren'}</h2>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        {successMsg && (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            {successMsg}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label className="form-label" htmlFor="email">E-Mail</label>
            <input
              id="email"
              type="email"
              className="form-input"
              placeholder="name@beispiel.de"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoCapitalize="none"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="password">Passwort</label>
            <input
              id="password"
              type="password"
              className="form-input"
              placeholder="Mindestens 6 Zeichen"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={6}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            style={{ marginTop: 8 }}
            disabled={loading}
          >
            {loading ? (
              <span className="spinner" style={{ borderTopColor: '#ffffff', width: 18, height: 18 }} />
            ) : (
              mode === 'login' ? 'Anmelden' : 'Konto erstellen'
            )}
          </button>
        </form>

        <div className="divider" style={{ margin: '20px 0' }} />

        <button
          className="btn btn-ghost w-full"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login')
            setError(null)
            setSuccessMsg(null)
          }}
        >
          {mode === 'login'
            ? 'Noch kein Konto? Registrieren'
            : 'Bereits registriert? Anmelden'
          }
        </button>
      </div>

      <p style={{ marginTop: 24, fontSize: '0.75rem', color: 'var(--color-ink-3)', textAlign: 'center' }}>
        Systemisches Coaching · Persönliche Wissensbasis
      </p>
    </div>
  )
}
