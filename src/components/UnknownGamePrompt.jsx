import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// Headless bridge for the overlay's "New game detected" notification. The
// suggestion itself now lives in the overlay window (visible over any game or
// the desktop) — this component only reacts when the user clicks "Add to
// library" there: main brings this window to the front and sends the exe here,
// and we prefill the Add Game flow and open it.
export default function UnknownGamePrompt() {
  const navigate = useNavigate()

  useEffect(() => {
    if (!window.kozo?.events?.onUnknownProcessAdd) return
    window.kozo.events.onUnknownProcessAdd(({ exe_name, install_path }) => {
      if (!exe_name) return
      sessionStorage.setItem('kozo:prefill-exe', exe_name)
      if (install_path) sessionStorage.setItem('kozo:prefill-install-path', install_path)
      navigate('/?add=1')
    })
    return () => window.kozo.events.removeAll('unknown-process:add')
  }, [])

  return null
}
