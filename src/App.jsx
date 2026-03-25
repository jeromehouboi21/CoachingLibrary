import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { Layout } from './components/Layout'
import LibraryScreen from './screens/library/LibraryScreen'
import DocumentScreen from './screens/document/DocumentScreen'
import ChatScreen from './screens/chat/ChatScreen'
import MethodsScreen from './screens/methods/MethodsScreen'
import UploadScreen from './screens/upload/UploadScreen'
import SearchScreen from './screens/search/SearchScreen'
import LoginScreen from './screens/login/LoginScreen'
import ProcessingScreen from './screens/processing/ProcessingScreen'
import AdminScreen from './screens/admin/AdminScreen'

function ProtectedRoute({ children, session }) {
  if (session === undefined) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh' }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    )
  }
  if (!session) {
    return <Navigate to="/login" replace />
  }
  return children
}

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading, null = not authed

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  return (
    <Routes>
      <Route path="/login" element={
        session ? <Navigate to="/" replace /> : <LoginScreen />
      } />
      <Route path="/*" element={
        <ProtectedRoute session={session}>
          <Layout session={session}>
            <Routes>
              <Route path="/" element={<LibraryScreen />} />
              <Route path="/doc/:id" element={<DocumentScreen />} />
              <Route path="/chat" element={<ChatScreen />} />
              <Route path="/methods" element={<MethodsScreen />} />
              <Route path="/search" element={<SearchScreen />} />
              <Route path="/upload" element={<UploadScreen />} />
              <Route path="/processing" element={<ProcessingScreen />} />
              <Route path="/admin" element={<AdminScreen />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        </ProtectedRoute>
      } />
    </Routes>
  )
}
