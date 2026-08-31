import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import AuthGate from './components/AuthGate.jsx'

// AuthGate wraps App, not individual routes: every route in this portal needs
// an operator identity, and the backend answers 401 rather than substituting a
// placeholder one. Gating here means an unauthenticated visitor sees a sign-in
// screen instead of a full UI whose every request fails.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <App />
      </AuthGate>
    </BrowserRouter>
  </StrictMode>,
)
