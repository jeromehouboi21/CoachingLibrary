import { NavLink } from 'react-router-dom'

const navItems = [
  { to: '/', icon: '📚', label: 'Bibliothek', exact: true },
  { to: '/chat', icon: '💬', label: 'Chat', exact: false },
  { to: '/search', icon: '🔍', label: 'Suche', exact: false },
  { to: '/methods', icon: '🛠', label: 'Methoden', exact: false },
  { to: '/upload', icon: '⬆️', label: 'Upload', exact: false },
]

export function Layout({ children }) {
  return (
    <div className="app-shell">
      <main>
        {children}
      </main>
      <nav className="bottom-nav" role="navigation" aria-label="Hauptnavigation">
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              `bottom-nav__item ${isActive ? 'active' : ''}`
            }
          >
            <span className="bottom-nav__icon" role="img" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
