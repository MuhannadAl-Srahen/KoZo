import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import OverlayApp from './OverlayApp'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/variables.css'
import './styles/global.css'

const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary silent={isOverlay}>
      {isOverlay ? <OverlayApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
)
