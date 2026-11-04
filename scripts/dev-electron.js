'use strict'

// Dev runner for the Electron side of `npm run dev`. Starts Electron and
// restarts it whenever a file under electron/ changes, so main-process and
// preload edits take effect without stopping the whole dev command. The
// restart asks KoZo to quit cleanly first (backup + DB flush on will-quit).
//
// Watch events alone can't be trusted: on Windows fs.watch also reports a file
// being READ as a "change" (no new modified time, no new content). KoZo reads
// its own files as it starts, so every restart fired the next one, up to seven
// in a row. A file only counts as changed when its content is different.

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const electronBin = require('electron')   // path to the Electron executable
const watchDir = path.join(root, 'electron')
const WATCHED = /\.(js|cjs|sql)$/i

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE           // VS Code terminals set this

let child = null
let restarting = false
let timer = null

// relative path -> hash of the content the running process should have loaded
const seen = new Map()
const pending = new Set()

// null = the file is gone. undefined = it couldn't be read yet (locked mid-save).
function hashOf(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(watchDir, file))).digest('hex') }
  catch (e) { return e.code === 'ENOENT' ? null : undefined }
}

for (const file of fs.readdirSync(watchDir, { recursive: true })) {
  if (WATCHED.test(file)) seen.set(file, hashOf(file))
}

function start() {
  child = spawn(electronBin, ['.'], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
  child.on('exit', (code) => {
    child = null
    if (restarting) { restarting = false; start(); return }
    process.exit(code ?? 0)                // the user quit KoZo: end the dev run
  })
}

function restart(files) {
  if (!child || restarting) return
  restarting = true
  console.log(`[dev] ${files.map(f => 'electron/' + f.replace(/\\/g, '/')).join(', ')} changed, restarting Electron`)
  try { child.send('kozo:dev-restart') } catch { child.kill() }
  const c = child
  setTimeout(() => { if (child === c) c.kill() }, 6000)
}

function check() {
  const changed = []
  for (const file of [...pending]) {
    const now = hashOf(file)
    if (now === undefined) continue          // still locked: stays pending for the retry below
    pending.delete(file)
    if (now === seen.get(file)) continue
    seen.set(file, now)
    changed.push(file)
  }
  if (changed.length) restart(changed)
  if (pending.size) timer = setTimeout(check, 400)
}

fs.watch(watchDir, { recursive: true }, (_event, file) => {
  if (!file || !WATCHED.test(file)) return
  pending.add(file)
  clearTimeout(timer)
  timer = setTimeout(check, 400)
})

process.on('SIGINT', () => { if (child) child.kill(); process.exit(0) })
process.on('SIGTERM', () => { if (child) child.kill(); process.exit(0) })

start()
