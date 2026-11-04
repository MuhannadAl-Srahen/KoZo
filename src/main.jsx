import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/main-root.css'
import TrayApp from './TrayApp'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/variables.css'
import './styles/global.css'
import './styles/motion.css'
import './styles/customize.css'

// The overlay window has its own page: overlay.html + overlay-main.jsx.
const params = new URLSearchParams(window.location.search)
const isTray = params.get('tray') === '1'   // the tray popup (electron/trayWindow.js)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isTray ? <TrayApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
)
