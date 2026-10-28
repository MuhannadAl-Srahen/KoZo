'use strict'

// Dev runner for the Electron side of `npm run dev`. Starts Electron and
// restarts it whenever a file under electron/ changes, so main-process and
// preload edits take effect without stopping the whole dev command. The
// restart asks KoZo to quit cleanly first (backup + DB flush on will-quit).

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const electronBin = require('electron')   // path to the Electron executable
const watchDir = path.join(root, 'electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE           // VS Code terminals set this

let child = null
let restarting = false
let timer = null

function start() {
  child = spawn(electronBin, ['.'], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
  child.on('exit', (code) => {
    child = null
    if (restarting) { restarting = false; start(); return }
    process.exit(code ?? 0)                // the user quit KoZo: end the dev run
  })
}

function restart() {
  if (!child || restarting) return
  restarting = true
  console.log('[dev] electron/ changed, restarting Electron')
  try { child.send('kozo:dev-restart') } catch { child.kill() }
  const c = child
  setTimeout(() => { if (child === c) c.kill() }, 6000)
}

fs.watch(watchDir, { recursive: true }, (_event, file) => {
  if (!file || !/\.(js|cjs|sql)$/i.test(file)) return
  clearTimeout(timer)
  timer = setTimeout(restart, 400)
})

process.on('SIGINT', () => { if (child) child.kill(); process.exit(0) })
process.on('SIGTERM', () => { if (child) child.kill(); process.exit(0) })

start()
