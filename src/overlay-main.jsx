// The overlay window's own page. It starts while a game is loading, so it loads
// only the toasts, not the whole app: parsing every page's code and styles here
// competed with the game for the CPU and GPU.
import React from 'react'
import ReactDOM from 'react-dom/client'
import OverlayApp from './OverlayApp'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/overlay-base.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary silent>
      <OverlayApp />
    </ErrorBoundary>
  </React.StrictMode>
)
