'use strict'

// The off-PC copy: KoZo's backups (game-save vaults + kozo-autobackup.json)
// copied to the user's Google Drive, in a "KoZo Backup" folder. Survives a
// format of every drive.
//
// - Sign-in: Google OAuth for installed apps (browser, PKCE, a one-shot
//   127.0.0.1 listener, like steamOpenId.js). Scope drive.file: KoZo only
//   sees the files it made. The refresh token is encrypted with safeStorage
//   (setting gdrive_token, never exported).
// - Sync (after a save backup, debounced, never while a game runs; and at
//   startup): uploads what Drive is missing.
// - The Google client ID: pasted once in KoZo (setting gdrive_client_id /
//   gdrive_client_secret, never exported) or built into defaults.js. Blobs are content-addressed and
//   deduplicated, so only changed save files ever go up.
// - Space: KoZo stays inside a budget (gdrive_budget_gb, default 1) and the
//   real free space of the Drive. When it doesn't fit, the oldest automatic
//   restore points are left out of the Drive copy (cloudPrunePlan); the copy
//   on this PC is never touched. Saves bigger than 2 GB stay on this PC only.
// - Files are named by their path under the backups ("Saves/Dead Cells/vault/
//   blobs/<sha1>.gz", "Data/kozo-autobackup.json"), so restoring on a new PC
//   is downloading them back to the same places.

const fs     = require('fs')
const path   = require('path')
const http   = require('http')
const crypto = require('crypto')
const logger = require('../logger')

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_NAME = 'KoZo Backup'
const BIG_GAME = 2 * 1024 ** 3
const GB = 1024 ** 3

function settings() { return require('../db/queries/settings') }
// The Google Cloud "Desktop app" client: the one the user pasted in KoZo
// (Connections, Set up Google Drive), else the one built into defaults.js.
function defaults() {
  const d = require('../defaults')
  const s = settings()
  const id = String(s.getSetting('gdrive_client_id') || '').trim()
  const secret = String(s.getSetting('gdrive_client_secret') || '').trim()
  return id ? { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } : d
}
function axios() { return require('axios') }

function budgetOf(s) { const v = s.getSetting('gdrive_budget_gb'); return v == null || v === '' ? 1 : Number(v) }
function configured() { return !!defaults().GOOGLE_CLIENT_ID }

// ── Tokens ──────────────────────────────────────────────────────────────────
function saveToken(tok) {
  const { safeStorage } = require('electron')
  const json = JSON.stringify(tok)
  const val = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(json).toString('base64') : 'raw:' + Buffer.from(json).toString('base64')
  settings().setSetting('gdrive_token', val)
}
function loadToken() {
  const v = settings().getSetting('gdrive_token')
  if (!v) return null
  try {
    const { safeStorage } = require('electron')
    if (v.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')))
    if (v.startsWith('raw:')) return JSON.parse(Buffer.from(v.slice(4), 'base64').toString('utf8'))
  } catch {}
  return null
}

let access = null   // { token, until }
async function accessToken() {
  if (access && access.until > Date.now() + 60000) return access.token
  const tok = loadToken()
  if (!tok?.refresh_token) throw new Error('not_connected')
  const d = defaults()
  const res = await axios().post('https://oauth2.googleapis.com/token', new URLSearchParams({
    client_id: d.GOOGLE_CLIENT_ID, client_secret: d.GOOGLE_CLIENT_SECRET,
    refresh_token: tok.refresh_token, grant_type: 'refresh_token',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 })
    .catch(e => {
      if (e.response?.data?.error === 'invalid_grant') {
        settings().setSetting('gdrive_token', '')
        throw new Error('signed_out')
      }
      throw e
    })
  access = { token: res.data.access_token, until: Date.now() + (res.data.expires_in || 3600) * 1000 }
  return access.token
}
async function api(method, url, opts = {}) {
  const token = await accessToken()
  for (let attempt = 0; ; attempt++) {
    try {
      return await axios()({ method, url, timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity, ...opts,
        headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } })
    } catch (e) {
      const st = e.response?.status
      if (attempt < 3 && (!st || st === 429 || st >= 500)) { await new Promise(r => setTimeout(r, 1500 * 2 ** attempt)); continue }
      throw e
    }
  }
}

// ── Sign in ─────────────────────────────────────────────────────────────────
let signing = null
function connect() {
  if (!configured()) return Promise.resolve({ error: 'not_configured' })
  if (signing) { try { signing.server.close() } catch {} ; signing.finish({ error: 'superseded' }) }
  const d = defaults()
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = crypto.randomBytes(16).toString('hex')
  return new Promise((resolve) => {
    let done = false
    const attempt = {}
    const finish = (r) => { if (done) return; done = true; clearTimeout(attempt.timer); if (signing === attempt) signing = null; resolve(r) }
    attempt.finish = finish
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return }
      const code = url.searchParams.get('code')
      const ok = code && url.searchParams.get('state') === state
      let result = { error: url.searchParams.get('error') || 'cancelled' }
      if (ok) {
        try {
          const tok = await axios().post('https://oauth2.googleapis.com/token', new URLSearchParams({
            code, client_id: d.GOOGLE_CLIENT_ID, client_secret: d.GOOGLE_CLIENT_SECRET,
            redirect_uri: attempt.redirect, grant_type: 'authorization_code', code_verifier: verifier,
          }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 })
          saveToken({ refresh_token: tok.data.refresh_token })
          access = { token: tok.data.access_token, until: Date.now() + (tok.data.expires_in || 3600) * 1000 }
          const about = await api('get', `${API}/about`, { params: { fields: 'user(emailAddress)' } })
          settings().setSetting('gdrive_email', about.data?.user?.emailAddress || '')
          result = { email: about.data?.user?.emailAddress || '' }
          logger.info('googleDrive: connected')
          syncSoon(2000)
        } catch (e) {
          logger.warn('googleDrive: sign-in failed', { message: e.message })
          result = { error: 'failed' }
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body style="margin:0;background:#0e0e1a;color:#ececf8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>${result.email != null ? 'KoZo is connected to Google Drive' : 'Google Drive was not connected'}</h2><p style="color:#7878a0">You can close this tab and go back to KoZo.</p></div></body></html>`)
      try { server.close() } catch {}
      finish(result)
    })
    attempt.server = server
    server.on('error', () => finish({ error: 'listener' }))
    server.listen(0, '127.0.0.1', () => {
      attempt.redirect = `http://127.0.0.1:${server.address().port}`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.search = new URLSearchParams({
        client_id: d.GOOGLE_CLIENT_ID, redirect_uri: attempt.redirect, response_type: 'code', scope: SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state,
      }).toString()
      require('electron').shell.openExternal(auth.toString())
    })
    attempt.timer = setTimeout(() => { try { server.close() } catch {} ; finish({ error: 'timeout' }) }, 5 * 60000)
    signing = attempt
  })
}

async function disconnect() {
  const tok = loadToken()
  if (tok?.refresh_token) {
    try { await axios().post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token: tok.refresh_token }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }) } catch {}
  }
  for (const k of ['gdrive_token', 'gdrive_email', 'gdrive_folder_id', 'gdrive_last_sync', 'gdrive_error']) settings().setSetting(k, '')
  access = null
  try { fs.rmSync(statePath(), { force: true }) } catch {}
  return true
}

// ── Remote folder and listing ───────────────────────────────────────────────
async function folderId() {
  const s = settings()
  const known = s.getSetting('gdrive_folder_id')
  if (known) {
    try {
      const r = await api('get', `${API}/files/${known}`, { params: { fields: 'id,trashed' } })
      if (!r.data.trashed) return known
    } catch {}
  }
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const found = await api('get', `${API}/files`, { params: { q, fields: 'files(id)', spaces: 'drive' } })
  let id = found.data.files?.[0]?.id
  if (!id) {
    const made = await api('post', `${API}/files`, { data: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }, params: { fields: 'id' } })
    id = made.data.id
  }
  s.setSetting('gdrive_folder_id', id)
  return id
}

async function listRemote(folder) {
  const out = new Map()
  let pageToken
  do {
    const r = await api('get', `${API}/files`, { params: {
      q: `'${folder}' in parents and trashed=false`, fields: 'nextPageToken,files(id,name,size)', pageSize: 1000, pageToken,
    } })
    for (const f of r.data.files || []) out.set(f.name, { id: f.id, size: Number(f.size) || 0 })
    pageToken = r.data.nextPageToken
  } while (pageToken)
  return out
}

async function upload(folder, name, abs, existingId = null) {
  const data = fs.readFileSync(abs)
  const meta = existingId ? {} : { name, parents: [folder], appProperties: { kozo: '1' } }
  if (data.length < 5 * 1024 * 1024) {
    const boundary = 'kozo' + crypto.randomBytes(8).toString('hex')
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--`),
    ])
    const r = await api(existingId ? 'patch' : 'post', existingId ? `${UPLOAD}/${existingId}` : UPLOAD, {
      params: { uploadType: 'multipart', fields: 'id,size' }, data: body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    })
    return r.data.id
  }
  const start = await api(existingId ? 'patch' : 'post', existingId ? `${UPLOAD}/${existingId}` : UPLOAD, {
    params: { uploadType: 'resumable' }, data: meta, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(data.length) },
  })
  const r = await api('put', start.headers.location, { data, headers: { 'Content-Type': 'application/octet-stream' } })
  return r.data.id
}

// ── What goes up ────────────────────────────────────────────────────────────
const AUTO = new Set(['before-play', 'after-play', 'auto', 'before-restore'])
// Which restore points fit in `budget` bytes. Pure.
// games: [{ key, snaps: [{ id, createdAt, reason, blobs: [[hash, bytes], ...] }] }]
// Drops the oldest automatic restore point (never a game's newest, never a
// manual one) until the deduplicated total fits. Returns { keep: Set of
// "key|id", bytes, over } (over = even the minimum doesn't fit).
function cloudPrunePlan(games, budget) {
  const refs = new Map()   // key|hash -> count
  const size = new Map()   // key|hash -> bytes
  for (const g of games) for (const s of g.snaps) for (const [h, n] of s.blobs) {
    const k = `${g.key}|${h}`
    refs.set(k, (refs.get(k) || 0) + 1); size.set(k, n)
  }
  let bytes = [...size.values()].reduce((a, n) => a + n, 0)
  const keep = new Set(games.flatMap(g => g.snaps.map(s => `${g.key}|${s.id}`)))
  if (!budget || bytes <= budget) return { keep, bytes, over: false }
  const droppable = []
  for (const g of games) {
    const newest = [...g.snaps].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
    for (const s of g.snaps) if (s !== newest && AUTO.has(s.reason)) droppable.push({ g, s })
  }
  droppable.sort((a, b) => String(a.s.createdAt).localeCompare(String(b.s.createdAt)))
  for (const { g, s } of droppable) {
    if (bytes <= budget) break
    keep.delete(`${g.key}|${s.id}`)
    for (const [h] of s.blobs) {
      const k = `${g.key}|${h}`
      const left = refs.get(k) - 1
      refs.set(k, left)
      if (left === 0) bytes -= size.get(k)
    }
  }
  return { keep, bytes, over: bytes > budget }
}

function statePath() { return path.join(require('electron').app.getPath('userData'), 'drive-state.json') }
function readState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return { up: {} } } }
function writeState(st) { try { fs.writeFileSync(statePath(), JSON.stringify(st)) } catch {} }

// Local backups as { name -> abs } plus per-game snapshot info for the plan.
function localPlan() {
  const savesRoot = require('./saveBackup').rootPath()
  const games = [], big = []
  for (const g of fs.readdirSync(savesRoot, { withFileTypes: true })) {
    if (!g.isDirectory()) continue
    const vault = path.join(savesRoot, g.name, 'vault')
    if (!fs.existsSync(path.join(vault, 'snapshots'))) continue
    const snaps = []
    for (const n of fs.readdirSync(path.join(vault, 'snapshots'))) {
      if (!n.endsWith('.json')) continue
      try {
        const s = JSON.parse(fs.readFileSync(path.join(vault, 'snapshots', n), 'utf8'))
        const hashes = [...new Set(s.files.map(f => f.h))]
        const blobs = hashes.map(h => { try { return [h, fs.statSync(path.join(vault, 'blobs', `${h}.gz`)).size] } catch { return null } }).filter(Boolean)
        if (blobs.length !== hashes.length) continue   // incomplete: never upload
        snaps.push({ id: s.id, createdAt: s.createdAt, reason: s.reason, bytes: s.bytes, file: n, blobs })
      } catch {}
    }
    if (!snaps.length) continue
    const newest = [...snaps].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
    if (newest.bytes > BIG_GAME) { big.push(g.name); continue }
    games.push({ key: g.name, vault, snaps })
  }
  return { games, big }
}

// ── Sync ────────────────────────────────────────────────────────────────────
let syncing = null
let soonTimer = null
function connected() { return !!loadToken()?.refresh_token }

function syncSoon(ms = 60000) {
  if (!configured() || !connected()) return
  clearTimeout(soonTimer)
  soonTimer = setTimeout(() => {
    const run = () => { sync().catch(() => {}) }
    try { require('./processWatcher').runWhenIdle('googleDriveSync', run) } catch { run() }
  }, ms)
}

function broadcastStatus() {
  try {
    const { BrowserWindow } = require('electron')
    const st = status()
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send('drive:status', st) }
  } catch {}
}

function busy() { try { return require('./processWatcher').isSessionActive() } catch { return false } }

async function sync() {
  if (!configured() || !connected()) return { skipped: 'not_connected' }
  if (syncing) return syncing
  syncing = (async () => {
    const s = settings()
    try {
      const folder = await folderId()
      const remote = await listRemote(folder)
      const about = await api('get', `${API}/about`, { params: { fields: 'storageQuota' } })
      const q = about.data.storageQuota || {}
      const remoteBytes = [...remote.values()].reduce((a, f) => a + f.size, 0)
      const budgetGb = budgetOf(s)
      let budget = budgetGb > 0 ? budgetGb * GB : 0
      if (q.limit) {
        const room = remoteBytes + (Number(q.limit) - Number(q.usage || 0)) - 512 * 1024 * 1024
        budget = budget ? Math.min(budget, room) : room
      }
      const { games, big } = localPlan()
      const plan = cloudPrunePlan(games.map(g => ({ key: g.key, snaps: g.snaps })), Math.max(budget, 1))

      // Wanted on Drive: name -> abs
      const want = new Map()
      for (const g of games) {
        const rel = (p) => ['Saves', g.key, 'vault', ...p].join('/')
        const meta = path.join(g.vault, 'meta.json')
        if (fs.existsSync(meta)) want.set(rel(['meta.json']), meta)
        for (const sn of g.snaps) {
          if (!plan.keep.has(`${g.key}|${sn.id}`)) continue
          for (const [h] of sn.blobs) want.set(rel(['blobs', `${h}.gz`]), path.join(g.vault, 'blobs', `${h}.gz`))
        }
      }
      // Snapshots after their blobs, so Drive never lists a restore point with
      // missing files.
      const snapsWanted = new Map()
      for (const g of games) for (const sn of g.snaps) {
        if (plan.keep.has(`${g.key}|${sn.id}`)) snapsWanted.set(['Saves', g.key, 'vault', 'snapshots', sn.file].join('/'), path.join(g.vault, 'snapshots', sn.file))
      }

      const state = readState()
      let up = 0, upBytes = 0
      for (const map of [want, snapsWanted]) {
        for (const [name, abs] of map) {
          if (busy()) { syncSoon(); return { paused: true } }
          if (remote.has(name)) { state.up[name] = state.up[name] || { id: remote.get(name).id }; continue }
          const id = await upload(folder, name, abs)
          state.up[name] = { id }
          up++; upBytes += fs.statSync(abs).size
          if (up % 25 === 0) writeState(state)
        }
      }
      // KoZo data: replaced when it changed.
      const dataDir = s.getSetting('auto_backup_dir')
      const dataFile = dataDir && path.join(dataDir, 'kozo-autobackup.json')
      if (dataFile && fs.existsSync(dataFile)) {
        const name = 'Data/kozo-autobackup.json'
        const m = fs.statSync(dataFile).mtimeMs
        if (!remote.has(name) || (state.up[name]?.m || 0) < m) {
          const id = await upload(folder, name, dataFile, remote.get(name)?.id || null)
          state.up[name] = { id, m }
          up++
        }
      }
      // Remove from Drive only what THIS install put there and no longer
      // wants (thinned or pruned). A fresh install (empty state) deletes nothing.
      let removed = 0
      for (const [name, f] of remote) {
        if (!state.up[name] || name.startsWith('Data/')) continue
        if (want.has(name) || snapsWanted.has(name)) continue
        // Snapshots first in the same pass doesn't matter: blobs a kept snapshot
        // uses are in `want`.
        try { await api('delete', `${API}/files/${f.id}`); delete state.up[name]; removed++ } catch {}
      }
      writeState(state)
      const result = {
        uploaded: up, uploadedBytes: upBytes, removed, bytes: plan.bytes, over: plan.over, big,
        quota: q.limit ? { limit: Number(q.limit), usage: Number(q.usage || 0) } : null,
      }
      s.setSetting('gdrive_last_sync', new Date().toISOString())
      s.setSetting('gdrive_last_result', JSON.stringify(result))
      s.setSetting('gdrive_error', '')
      if (up || removed) logger.info(`googleDrive: uploaded ${up}, removed ${removed}`)
      broadcastStatus()
      return result
    } catch (e) {
      const msg = e.message === 'signed_out' ? 'signed_out' : (e.response?.data?.error?.message || e.message)
      s.setSetting('gdrive_error', msg)
      logger.warn('googleDrive: sync failed', { message: msg })
      return { error: msg }
    } finally {
      syncing = null
      broadcastStatus()
    }
  })()
  return syncing
}

// ── Restore (a new PC, or after a format) ───────────────────────────────────
// Downloads what this PC is missing back to the same places. Returns the path
// of the KoZo data file (to import) when there is one.
async function restoreDown(onProgress) {
  const folder = await folderId()
  const remote = await listRemote(folder)
  const savesRoot = require('./saveBackup').rootPath()
  let n = 0, total = remote.size, dataPath = null
  for (const [name, f] of remote) {
    n++
    let dest
    if (name === 'Data/kozo-autobackup.json') dest = path.join(require('electron').app.getPath('temp'), `kozo-drive-${Date.now()}.json`)
    else if (name.startsWith('Saves/')) {
      const rel = name.slice(6).split('/')
      if (rel.some(p => !p || p === '..' || p === '.')) continue
      dest = path.join(savesRoot, ...rel)
      if (fs.existsSync(dest)) continue
    } else continue
    const r = await api('get', `${API}/files/${f.id}`, { params: { alt: 'media' }, responseType: 'arraybuffer' })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest + '.tmp', Buffer.from(r.data))
    fs.renameSync(dest + '.tmp', dest)
    if (name.startsWith('Data/')) dataPath = dest
    onProgress?.(n, total)
  }
  return { files: n, dataPath }
}

function status() {
  const s = settings()
  let last = null
  try { last = JSON.parse(s.getSetting('gdrive_last_result') || 'null') } catch {}
  return {
    configured: configured(),
    connected: connected(),
    email: s.getSetting('gdrive_email') || '',
    lastSync: s.getSetting('gdrive_last_sync') || null,
    syncing: !!syncing,
    error: s.getSetting('gdrive_error') || null,
    budgetGb: budgetOf(s),
    last,
  }
}

module.exports = { configured, connected, connect, disconnect, sync, syncSoon, restoreDown, status, cloudPrunePlan }
