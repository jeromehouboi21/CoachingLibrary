import { useNavigate } from 'react-router-dom'

export function SourceCard({ doc }) {
  const navigate = useNavigate()

  return (
    <div
      className="source-card"
      onClick={() => navigate(`/doc/${doc.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/doc/${doc.id}`) }}
    >
      <span className="source-card-icon" role="img" aria-hidden="true">📄</span>
      <div>
        <div className="source-card-title">{doc.title}</div>
        {doc.summary && (
          <div className="source-card-excerpt">
            {doc.summary.slice(0, 100)}{doc.summary.length > 100 ? '…' : ''}
          </div>
        )}
      </div>
    </div>
  )
}
