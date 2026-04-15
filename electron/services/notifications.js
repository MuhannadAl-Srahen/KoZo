// OS (Windows) notifications were intentionally removed.
//
// In dev/unpackaged builds Windows shows the toast source as
// "electron.app.Electron" (it needs a registered Start-Menu shortcut whose
// AppUserModelID matches to display "KoZo"), which looks broken. The in-app
// AchievementToast plus the always-on-top game overlay (electron/overlayWindow.js)
// cover every case — including over a fullscreen game — so OS toasts are
// redundant. These are kept as no-ops so existing call sites keep working.

function notify() {}
function notifyAchievements() {}
function notifySessionStarted() {}
function notifySessionEnded() {}

module.exports = { notify, notifyAchievements, notifySessionStarted, notifySessionEnded }
