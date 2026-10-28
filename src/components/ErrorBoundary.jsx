import React from 'react'

// Last line of defence: an error thrown while rendering used to unmount the
// whole tree and leave an empty window. Show what broke and a way out instead.
// console.error also lands in the main-process log (see electron/main.js).
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('KoZo render error:', error?.stack || error, info?.componentStack || '')
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.silent) return null   // the overlay must never cover a game with an error page
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 'var(--sp-4, 16px)', padding: 'var(--sp-6, 24px)',
        background: 'var(--bg, #0b0b10)', color: 'var(--text, #e8e8f0)', textAlign: 'center',
      }}>
        <h2 style={{ margin: 0 }}>Something went wrong</h2>
        <p style={{ margin: 0, color: 'var(--text-muted, #9a9ab0)', maxWidth: 560 }}>
          KoZo hit an error while drawing this screen. Your data is safe. Reloading usually fixes it.
        </p>
        <pre style={{
          maxWidth: '90vw', maxHeight: '30vh', overflow: 'auto', margin: 0, padding: 12,
          borderRadius: 8, background: 'rgba(255,255,255,0.05)', fontSize: 12, textAlign: 'left',
          whiteSpace: 'pre-wrap',
        }}>{String(error?.message || error)}</pre>
        <button
          onClick={() => { window.location.hash = '#/'; window.location.reload() }}
          style={{
            padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'var(--a, #8b5cf6)', color: '#fff', fontWeight: 600,
          }}
        >
          Reload KoZo
        </button>
      </div>
    )
  }
}
