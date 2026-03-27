import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { useChat } from '../../hooks/useChat'
import { SourceCard } from '../../components/SourceCard'

function formatMessage(content) {
  // Replace [[DOC:uuid]] markers with a placeholder span (sources shown separately)
  return content.replace(/\[\[DOC:[a-f0-9-]+\]\]/g, '')
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user'
  const text = formatMessage(message.content)

  return (
    <div className={`chat-message chat-message--${isUser ? 'user' : 'assistant'}`}>
      <div className="chat-bubble">
        {isUser ? (
          <>
            {text || (message.streaming ? '' : '…')}
          </>
        ) : (
          <>
            <div className="chat-message-content">
              <ReactMarkdown>{text || (message.streaming ? '' : '…')}</ReactMarkdown>
            </div>
            {message.streaming && text && <span className="chat-cursor" aria-hidden="true" />}
          </>
        )}
        {isUser && message.streaming && text && <span className="chat-cursor" aria-hidden="true" />}
      </div>
      {!isUser && !message.streaming && message.sources && message.sources.length > 0 && (
        <div className="chat-sources">
          <div style={{ fontSize: '0.75rem', color: 'var(--color-ink-3)', marginBottom: 4, paddingLeft: 2 }}>
            Quellen:
          </div>
          {message.sources.map(src => (
            <SourceCard key={src.id} doc={src} />
          ))}
        </div>
      )}
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="chat-typing-indicator">
      <span />
      <span />
      <span />
    </div>
  )
}

export default function ChatScreen() {
  const [sessionId] = useState(() => crypto.randomUUID())
  const { messages, sendMessage, loading, clearMessages } = useChat(sessionId)
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  function handleSend() {
    const text = inputValue.trim()
    if (!text || loading) return
    setInputValue('')
    sendMessage(text)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="chat-container">
      {/* Header */}
      <div className="screen-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="screen-title">KI-Assistent</h1>
          <p className="screen-subtitle">Frage deine Coaching-Bibliothek</p>
        </div>
        {messages.length > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={clearMessages}
            title="Neues Gespräch"
          >
            ✕ Neu
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 12,
            padding: '40px 24px',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '3rem' }}>🌿</div>
            <h2 style={{ fontFamily: 'DM Serif Display, Georgia, serif', fontSize: '1.375rem', color: 'var(--color-ink)' }}>
              Was möchtest du wissen?
            </h2>
            <p style={{ fontSize: '0.9375rem', color: 'var(--color-ink-2)', maxWidth: 280 }}>
              Stelle Fragen zu deinen Coaching-Materialien und ich antworte auf Basis deiner Bibliothek.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 320, marginTop: 8 }}>
              {[
                'Was sind die Grundprinzipien des systemischen Coachings?',
                'Erkläre mir die zirkuläre Befragung.',
                'Welche Methoden eignen sich für Teamentwicklung?',
              ].map(suggestion => (
                <button
                  key={suggestion}
                  className="card card--interactive"
                  style={{ padding: '10px 14px', textAlign: 'left', fontSize: '0.875rem', color: 'var(--color-ink-2)' }}
                  onClick={() => {
                    setInputValue(suggestion)
                    inputRef.current?.focus()
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {loading && !messages[messages.length - 1]?.streaming && (
              <TypingIndicator />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className="chat-input-bar">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Nachricht schreiben..."
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          aria-label="Nachricht eingeben"
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!inputValue.trim() || loading}
          aria-label="Senden"
        >
          ➤
        </button>
      </div>
    </div>
  )
}
