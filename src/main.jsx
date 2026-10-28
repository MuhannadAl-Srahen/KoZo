import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import OverlayApp from './OverlayApp'
import TrayApp from './TrayApp'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/variables.css'
import './styles/global.css'

const params = new URLSearchParams(window.location.search)
const isOverlay = params.get('overlay') === '1'
const isTray = params.get('tray') === '1'   // the tray popup (electron/trayWindow.js)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary silent={isOverlay}>
      {isOverlay ? <OverlayApp /> : isTray ? <TrayApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
)
