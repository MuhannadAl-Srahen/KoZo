'use strict'

// Versioned game-save backups. Replaces the old folder copies (saveBackup.js
// keeps the per-game folder/ownership rules and is still used for them):
//
//   <backups root>/<Game>/vault/
//     meta.json                 { gameId, gameName } (folder ownership, see saveBackup.folderOwner)
//     blobs/<sha1>.gz           every distinct file once, gzip-compressed
//     snapshots/<id>.json       one restore point: which file (source + relative
//                               path) had which content, why it was taken, sizes
//
// - Unchanged saves cost nothing: identical content is stored once, and a
//   snapshot identical to the previous automatic one isn't written at all.
// - Files are hashed while copying and checked after writing; a snapshot only
//   exists once its JSON is written (written to .tmp, then renamed).
// - Restore REPLACES a save folder with the snapshot (staged, verified, then
//   swapped), so nothing the game wrote later is left mixed in.
// - Smart history for automatic snapshots (prunePolicy), manual ones are kept.
// - Logs, caches, crash dumps and videos inside a save folder are left out
//   (saveDetect.isJunk); nothing is written when the drive is nearly full.
// - Off-PC copies: a folder the user picks (backupCopy.js, using the mirror
//   below) and Google Drive (googleDrive.js). The older `save_mirror_dir`
//   still works when it was set.

const fs     = require('fs')
const path   = require('path')
const zlib   = require('zlib')
const crypto = require('crypto')
const logger = require('../logger')

const { isJunk } = require('./saveDetect')
const MIN_FREE = 2 * 1024 ** 3
const BIG_FILE = 256 * 1024 ** 2

const AUTO_REASONS = new Set(['before-play', 'after-play', 'auto', 'before-restore'])
const DAY = 86400000
const MAX_FILES = 20000

function settings() { return require('../db/queries/settings') }
function backupRoot() { return require('./saveBackup').rootPath() }

// ── Paths ───────────────────────────────────────────────────────────────────
function vaultDir(game) {
  const dir = path.join(require('./saveBackup').gameDir(game.name, game.id != null ? String(game.id) : undefined), 'vault')
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true })
  const meta = path.join(dir, 'meta.json')
  if (!fs.existsSync(meta)) {
    try { fs.writeFileSync(meta, JSON.stringify({ gameId: game.id ?? null, gameName: game.name || '', vault: 1 }, null, 2)) } catch {}
  }
  return dir
}
// The vault if this game has one, else null (reads never create folders).
function existingVault(game) {
  const g = require('./saveBackup').existingGameDir(game.name, game.id != null ? String(game.id) : undefined)
  const v = g && path.join(g, 'vault')
  return v && fs.existsSync(path.join(v, 'snapshots')) ? v : null
}
const blobPath = (vault, hash) => path.join(vault, 'blobs', `${hash}.gz`)

function safeId(id) {
  const s = String(id || '')
  if (!/^[0-9A-Za-z_.-]+$/.test(s) || s.startsWith('.')) throw new Error('Invalid snapshot id')
  return s
}

// ── Second copy (mirror) ────────────────────────────────────────────────────
// Two ways to have one: `backup_copy_dir` (backupCopy.js, <dir>\Saves), or the
// older `save_mirror_dir` (<dir>\KoZo Saves), which still works when it was set.
function mirrorRoot() {
  const c = String(settings().getSetting('backup_copy_dir') || '').trim()
  if (c) return c
  const m = String(settings().getSetting('save_mirror_dir') || '').trim()
  return m || null
}
function mirrorSaves() {
  const c = String(settings().getSetting('backup_copy_dir') || '').trim()
  if (c) return path.join(c, 'Saves')
  const m = mirrorRoot()
  return m ? path.join(m, 'KoZo Saves') : null
}
// The mirror is a replica of the backups root: same relative layout.
function mirrorPathOf(abs) {
  const m = mirrorSaves()
  if (!m) return null
  const rel = path.relative(backupRoot(), abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return path.join(m, rel)
}
function gameBusy() {
  try { return require('./processWatcher').isSessionActive() } catch { return false }
}
function mirrorWrite(abs) {
  const dest = mirrorPathOf(abs)
  if (!dest) return
  // The folder may be a slow synced drive, and nothing heavy runs while a game
  // does. backupCopy.syncSoon() picks these files up after the session.
  if (gameBusy()) return
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    // Via a temp name: a half-copied file would otherwise look finished forever.
    fs.copyFileSync(abs, `${dest}.tmp`)
    fs.renameSync(`${dest}.tmp`, dest)
    settings().setSetting('save_mirror_last', new Date().toISOString())
  } catch (e) {
    logger.warn('saveVault: second copy failed', { message: e.message })
  }
}
function mirrorDelete(abs) {
  const dest = mirrorPathOf(abs)
  if (dest) { try { fs.rmSync(dest, { force: true }) } catch {} }
}

// ── Reading a save folder ───────────────────────────────────────────────────
// Every file under each source (a folder or a single file). `s` = index of the
// source, `p` = path relative to it ('' for a single-file source).
function listSourceFiles(sources) {
  const out = []
  sources.forEach((src, s) => {
    let st
    try { st = fs.statSync(src) } catch { return }
    if (st.isFile()) { out.push({ s, p: '', abs: src, n: st.size, m: Math.round(st.mtimeMs) }); return }
    const walk = (dir, rel) => {
      if (out.length > MAX_FILES) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (!e.name.endsWith('.kozo-restore') && !e.name.endsWith('.kozo-old')) walk(abs, r) }
        else if (e.isFile() && !isJunk(r)) {
          try {
            const fst = fs.statSync(abs)
            // A single file this big inside a save folder is game data, not a save.
            if (fst.size > BIG_FILE) { logger.debug(`saveVault: skipped ${abs} (${Math.round(fst.size / 1048576)} MB)`); continue }
            out.push({ s, p: r, abs, n: fst.size, m: Math.round(fst.mtimeMs) })
          } catch {}
        }
      }
    }
    walk(src, '')
  })
  return out
}

function hashFile(abs) {
  return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex')
}

// Store one file's content (if new) and return its hash. The blob is written
// to .tmp, read back and checked before it takes its real name.
// `fast` (right before a game starts): lighter compression, so the backup
// never competes with the game loading; after-play backups use the strongest.
function storeBlob(vault, abs, fast = false) {
  const data = fs.readFileSync(abs)
  const hash = crypto.createHash('sha1').update(data).digest('hex')
  const dest = blobPath(vault, hash)
  if (fs.existsSync(dest)) return hash
  const tmp = dest + '.tmp'
  fs.writeFileSync(tmp, zlib.gzipSync(data, { level: fast ? 5 : 9 }))
  const check = crypto.createHash('sha1').update(zlib.gunzipSync(fs.readFileSync(tmp))).digest('hex')
  if (check !== hash) { try { fs.rmSync(tmp, { force: true }) } catch {} ; throw new Error(`Backup copy of ${path.basename(abs)} did not verify`) }
  fs.renameSync(tmp, dest)
  mirrorWrite(dest)
  return hash
}

function readBlob(vault, hash) {
  let file = blobPath(vault, hash)
  if (!fs.existsSync(file)) {
    const m = mirrorPathOf(file)
    if (m && fs.existsSync(m)) file = m
  }
  const data = zlib.gunzipSync(fs.readFileSync(file))
  if (crypto.createHash('sha1').update(data).digest('hex') !== hash) throw new Error('A backed up file is damaged')
  return data
}

// ── Snapshots ───────────────────────────────────────────────────────────────
// Pure: a restore point names the folders it came from, with that PC's Windows user in them.
// On another PC with another user name that's nobody's home, and the game would never read
// a save put there. Public and the like are the same on every PC.
function mapSource(src, home) {
  const text = String(src)
  const m = /^[a-z]:[\\/]users[\\/]([^\\/]+)(?=[\\/]|$)/i.exec(text)
  if (!m || /^(public|default|default user|all users)$/i.test(m[1])) return text
  const mine = String(home).replace(/[\\/]+$/, '')
  return m[0].toLowerCase() === mine.toLowerCase() ? text : mine + text.slice(m[0].length)
}
const sourcesHere = (sources) => (sources || []).map(src => mapSource(src, require('os').homedir()))

function readSnapshot(vault, id) {
  const snap = JSON.parse(fs.readFileSync(path.join(vault, 'snapshots', `${safeId(id)}.json`), 'utf8'))
  snap.sources = sourcesHere(snap.sources)
  return snap
}
const readSnapshotFor = (game, id) => readSnapshot(vaultDir(game), id)

// Where a restore point's folders go now: a crack's save folder from before an update
// goes to the folder the game's current crack reads (crackSaves.js). Restoring to the
// old crack's folder left an updated game on an empty profile.
function targetsFor(game, sources) {
  try {
    const cs = require('./crackSaves')
    return cs.retarget(sources, {
      appid: String(game.steam_app_id || game.manual_appid || ''),
      installPath: game.install_path,
      current: cs.currentCloudFolder(game),
    })
  } catch { return sources }
}

function listSnapshots(game) {
  const vault = existingVault(game)
  if (!vault) return []
  let names = []
  try { names = fs.readdirSync(path.join(vault, 'snapshots')).filter(n => n.endsWith('.json')) } catch {}
  const out = []
  for (const n of names) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(vault, 'snapshots', n), 'utf8'))
      out.push({
        id: snap.id, createdAt: snap.createdAt, reason: snap.reason, label: snap.label || null,
        sources: sourcesHere(snap.sources), files: snap.files.length, bytes: snap.bytes,
      })
    } catch {}
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return out
}

function sameContent(a, b) {
  if (!a || !b || a.files.length !== b.files.length) return false
  if (a.sources.join('|').toLowerCase() !== b.sources.join('|').toLowerCase()) return false
  const key = (f) => `${f.s}|${f.p}|${f.h}`
  const set = new Set(a.files.map(key))
  return b.files.every(f => set.has(key(f)))
}

// Back up `sources` (absolute folders or files) for `game`. reason: manual |
// before-play | after-play | before-restore. Returns the snapshot summary, or
// { skipped } when there was nothing to store.
// `opts.maxMs` gives up (cleanly, nothing half-written) once that long has
// passed: the before-play backup must never hold a game's launch up.
function snapshot(game, sources, reason = 'manual', opts = {}) {
  sources = (sources || []).filter(Boolean)
  if (!sources.length) return { skipped: 'no_source' }
  const started = Date.now()
  const free = require('./backupHome').freeSpace(backupRoot())
  if (free != null && free < MIN_FREE) {
    try { settings().setSetting('save_low_space', new Date().toISOString()) } catch {}
    logger.warn(`saveVault: under 2 GB free on the backup drive, skipped "${game.name}"`)
    return { skipped: 'low_space' }
  }
  const vault = vaultDir(game)
  const files = listSourceFiles(sources)
  if (!files.length) return { skipped: 'empty' }

  // Reuse the hash of any file whose size and modified time match the newest
  // snapshot: only changed files are read, so a backup of an unchanged save
  // is a quick walk.
  const prevList = listSnapshots(game)
  let prev = null
  try { if (prevList[0]) prev = readSnapshot(vault, prevList[0].id) } catch {}
  const known = new Map()
  if (prev) for (const f of prev.files) known.set(`${prev.sources[f.s]}|${f.p}`.toLowerCase(), f)

  const entries = []
  let bytes = 0
  for (const f of files) {
    if (opts.maxMs && Date.now() - started > opts.maxMs) return { skipped: 'too_slow' }
    const k = known.get(`${sources[f.s]}|${f.p}`.toLowerCase())
    let h
    if (k && k.n === f.n && k.m === f.m && fs.existsSync(blobPath(vault, k.h))) h = k.h
    else {
      try { h = storeBlob(vault, f.abs, !!opts.fast) }
      catch (e) {
        // A file the game holds locked (rare for saves): skip it, say so.
        logger.warn(`saveVault: could not read ${f.abs}`, { message: e.message })
        continue
      }
    }
    entries.push({ s: f.s, p: f.p, h, n: f.n, m: f.m })
    bytes += f.n
  }
  if (!entries.length) return { skipped: 'unreadable' }

  const snap = {
    id: `${new Date().toISOString().replace(/[:.]/g, '-')}_${reason}`,
    gameId: game.id ?? null, gameName: game.name || '',
    createdAt: new Date().toISOString(), reason, label: opts.label || null,
    sources, files: entries, bytes,
  }
  // An automatic backup identical to the newest one adds nothing.
  if (reason !== 'manual' && prev && sameContent(prev, snap)) return { skipped: 'unchanged' }

  const file = path.join(vault, 'snapshots', `${snap.id}.json`)
  fs.writeFileSync(file + '.tmp', JSON.stringify(snap))
  fs.renameSync(file + '.tmp', file)
  mirrorWrite(file)
  logger.info(`saveVault: ${reason} backup of "${game.name}" (${entries.length} files, ${Math.round(bytes / 1024)} KB)`)
  try { prune(game) } catch (e) { logger.warn('saveVault: prune failed', { message: e.message }) }
  return { id: snap.id, createdAt: snap.createdAt, reason, files: entries.length, bytes }
}

// What restoring would change: files that differ, are new, or would be removed.
function compare(game, id) {
  const vault = vaultDir(game)
  const snap = readSnapshot(vault, id)
  snap.sources = targetsFor(game, snap.sources)
  const now = listSourceFiles(snap.sources)
  const cur = new Map(now.map(f => [`${f.s}|${f.p}`, f]))
  let changed = 0, missing = 0
  for (const f of snap.files) {
    const c = cur.get(`${f.s}|${f.p}`)
    if (!c) missing++
    else if (c.n !== f.n || hashFile(c.abs) !== f.h) changed++
    cur.delete(`${f.s}|${f.p}`)
  }
  return { changed, missing, extra: cur.size, files: snap.files.length, sources: snap.sources }
}

// Put a snapshot back exactly. Each folder source is rebuilt in a staging
// folder beside it, verified, then swapped in; a file source is replaced via
// a temp file. The current save is backed up first (before-restore); if that
// fails, nothing is touched.
function restore(game, id) {
  // A running game holds its saves and writes them again on exit, over the restore.
  let running = false
  try { running = require('./processWatcher').getActiveSessions().has(game.id) } catch {}
  if (running) throw new Error(`Close ${game.name} first: a running game would write over the restored save. Nothing was changed`)
  const vault = vaultDir(game)
  const snap = readSnapshot(vault, id)
  snap.sources = targetsFor(game, snap.sources)
  // A restore point from another PC can name a drive this one doesn't have.
  const away = snap.sources.find(src => !fs.existsSync(path.parse(src).root))
  if (away) throw new Error(`This restore point's save folder is on ${path.parse(away).root}, which this PC doesn't have. Nothing was changed`)
  const exists = snap.sources.filter(src => fs.existsSync(src))
  let safety = null
  if (exists.length) {
    const r = snapshot(game, snap.sources, 'before-restore')
    if (r.skipped && !['unchanged', 'empty'].includes(r.skipped)) {
      throw new Error(`Could not back up the current save first (${r.skipped}). Nothing was changed`)
    }
    safety = r.id || null
  }

  snap.sources.forEach((src, s) => {
    const files = snap.files.filter(f => f.s === s)
    const single = files.length === 1 && files[0].p === ''
    if (single) {
      fs.mkdirSync(path.dirname(src), { recursive: true })
      const tmp = src + '.kozo-restore'
      fs.writeFileSync(tmp, readBlob(vault, files[0].h))
      try { fs.rmSync(src, { force: true }) } catch {}
      fs.renameSync(tmp, src)
      return
    }
    const stage = src.replace(/[\\/]+$/, '') + '.kozo-restore'
    const old = src.replace(/[\\/]+$/, '') + '.kozo-old'
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })
    for (const f of files) {
      const dest = path.join(stage, ...f.p.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, readBlob(vault, f.h))
      try { fs.utimesSync(dest, new Date(), new Date(f.m)) } catch {}
    }
    // Swap. If the live folder can't be moved (the game is running and holds
    // it), stop before anything is lost.
    fs.rmSync(old, { recursive: true, force: true })
    if (fs.existsSync(src)) {
      try { fs.renameSync(src, old) }
      catch (e) {
        fs.rmSync(stage, { recursive: true, force: true })
        throw new Error(`The save folder is in use (is the game still running?). Nothing was changed`)
      }
    } else {
      fs.mkdirSync(path.dirname(src), { recursive: true })
    }
    try { fs.renameSync(stage, src) }
    catch (e) {
      if (fs.existsSync(old)) fs.renameSync(old, src)
      fs.rmSync(stage, { recursive: true, force: true })
      throw new Error(`Restore failed (${e.message}). Your save was put back as it was`)
    }
    fs.rmSync(old, { recursive: true, force: true })
  })
  logger.info(`saveVault: restored "${game.name}" from ${id}`)
  return { restored: id, safety }
}

// Copy a snapshot out as plain files (to look at or copy by hand).
function exportSnapshot(game, id, destRoot) {
  const vault = vaultDir(game)
  const snap = readSnapshot(vault, id)
  const out = path.join(destRoot, `${game.name.replace(/[<>:"/\\|?*]/g, '')} ${snap.id}`)
  for (const f of snap.files) {
    const base = snap.sources.length > 1 ? path.join(out, `Location ${f.s + 1}`) : out
    const dest = f.p ? path.join(base, ...f.p.split('/')) : path.join(base, path.basename(snap.sources[f.s]))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, readBlob(vault, f.h))
  }
  return out
}

function remove(game, id) {
  const vault = vaultDir(game)
  const file = path.join(vault, 'snapshots', `${safeId(id)}.json`)
  fs.rmSync(file, { force: true })
  mirrorDelete(file)
  gc(game)
  return true
}

// ── Smart history ───────────────────────────────────────────────────────────
// Automatic snapshots: all from the last 7 days, then the newest per day up
// to 30 days, then the newest per week up to 90 days. Manual ones are kept.
// The newest snapshot always survives. Pure, so it can be unit tested.
function prunePolicy(snaps, now = Date.now()) {
  const sorted = [...snaps].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const keep = new Set()
  const seenDay = new Set(), seenWeek = new Set()
  sorted.forEach((s, i) => {
    if (i === 0 || !AUTO_REASONS.has(s.reason)) { keep.add(s.id); return }
    const age = now - new Date(s.createdAt).getTime()
    if (age <= 7 * DAY) { keep.add(s.id); return }
    if (age <= 30 * DAY) {
      const d = String(s.createdAt).slice(0, 10)
      if (!seenDay.has(d)) { seenDay.add(d); keep.add(s.id) }
      return
    }
    if (age <= 90 * DAY) {
      const w = Math.floor(new Date(s.createdAt).getTime() / (7 * DAY))
      if (!seenWeek.has(w)) { seenWeek.add(w); keep.add(s.id) }
    }
  })
  return sorted.filter(s => !keep.has(s.id)).map(s => s.id)
}

function prune(game) {
  const vault = vaultDir(game)
  const drop = prunePolicy(listSnapshots(game))
  for (const id of drop) {
    const file = path.join(vault, 'snapshots', `${id}.json`)
    try { fs.rmSync(file, { force: true }); mirrorDelete(file) } catch {}
  }
  if (drop.length) gc(game)
  return drop.length
}

// Delete blobs no snapshot uses any more.
function gc(game) {
  const vault = vaultDir(game)
  const used = new Set()
  for (const s of listSnapshots(game)) {
    try { readSnapshot(vault, s.id).files.forEach(f => used.add(f.h)) } catch { return }   // unreadable snapshot: keep everything
  }
  let removed = 0
  for (const n of fs.readdirSync(path.join(vault, 'blobs'))) {
    const h = n.replace(/\.gz(\.tmp)?$/, '')
    if (!used.has(h)) {
      const file = path.join(vault, 'blobs', n)
      try { fs.rmSync(file, { force: true }); mirrorDelete(file); removed++ } catch {}
    }
  }
  return removed
}

function dirSize(dir) {
  let bytes = 0
  try {
    for (const n of fs.readdirSync(dir)) { try { bytes += fs.statSync(path.join(dir, n)).size } catch {} }
  } catch {}
  return bytes
}

// Space used on disk (compressed, deduplicated) by one game's backups.
function usage(game) {
  const vault = existingVault(game)
  if (!vault) return 0
  return dirSize(path.join(vault, 'blobs')) + dirSize(path.join(vault, 'snapshots'))
}

// Storage cap (setting save_vault_cap_gb, default 2, 0 = off): drop the oldest
// automatic snapshots across all games until the total fits. Never a game's
// newest one.
function capGb() {
  const v = settings().getSetting('save_vault_cap_gb')
  return v == null || v === '' ? 2 : Number(v) || 0
}
function enforceCap(games) {
  const cap = capGb() * 1024 ** 3
  if (!cap) return 0
  let total = games.reduce((a, g) => a + usage(g), 0)
  let dropped = 0
  while (total > cap) {
    let oldest = null
    for (const g of games) {
      const list = listSnapshots(g)
      for (const s of list.slice(1)) {
        if (!AUTO_REASONS.has(s.reason)) continue
        if (!oldest || String(s.createdAt) < String(oldest.s.createdAt)) oldest = { g, s }
      }
    }
    if (!oldest) break
    remove(oldest.g, oldest.s.id)
    dropped++
    total = games.reduce((a, g) => a + usage(g), 0)
  }
  return dropped
}

// Copy anything the second copy is missing (after it was first set, or after
// it was offline). Also the other way round: a fresh install pointed at an
// old second copy gets everything back.
//
// Async: a first copy of a large vault must not freeze the app. Sorted, so blobs
// go before snapshots and a snapshot never arrives ahead of its files. Stops if
// a game starts ({ paused: true }); the caller runs it again afterwards.
let mirrorRun = null
function syncMirror() {
  if (mirrorRun) return mirrorRun
  mirrorRun = runSyncMirror().finally(() => { mirrorRun = null })
  return mirrorRun
}
async function runSyncMirror() {
  const mroot = mirrorSaves()
  if (!mroot) return { copied: 0 }
  const root = backupRoot()
  // Unplugged, or the cloud drive isn't mounted: say so rather than report a
  // copy that never happened.
  try { await fs.promises.mkdir(mroot, { recursive: true }) } catch (e) {
    logger.warn('saveVault: second copy folder unreachable', { message: e.message })
    return { copied: 0, error: 'unreachable' }
  }
  const list = async (dir) => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      return entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    } catch { return [] }
  }
  const exists = (p) => fs.promises.access(p).then(() => true, () => false)
  let copied = 0, failed = 0, paused = false
  const sync = async (from, to) => {
    for (const e of await list(from)) {
      if (paused) return
      const a = path.join(from, e.name), b = path.join(to, e.name)
      if (e.isDirectory()) { await sync(a, b); continue }
      if (!e.isFile() || e.name.endsWith('.tmp') || await exists(b)) continue
      if (gameBusy()) { paused = true; return }
      try {
        await fs.promises.mkdir(to, { recursive: true })
        await fs.promises.copyFile(a, `${b}.tmp`)
        await fs.promises.rename(`${b}.tmp`, b)
        copied++
      } catch (err) {
        failed++
        logger.warn('saveVault: second copy failed', { message: err.message })
      }
    }
  }
  // Only vault folders travel; old-style folder copies stay local.
  for (const g of await list(root)) {
    if (g.isDirectory()) await sync(path.join(root, g.name, 'vault'), path.join(mroot, g.name, 'vault'))
  }
  for (const g of await list(mroot)) {
    if (g.isDirectory()) await sync(path.join(mroot, g.name, 'vault'), path.join(root, g.name, 'vault'))
  }
  if (!paused && !failed) settings().setSetting('save_mirror_last', new Date().toISOString())
  return { copied, failed, paused, error: failed ? 'failed' : undefined }
}

// Game folders holding nothing but an empty vault (an older build made one
// for every game just by listing them). Removed at startup.
function cleanEmpty() {
  const root = backupRoot()
  let removed = 0
  for (const e of (() => { try { return fs.readdirSync(root, { withFileTypes: true }) } catch { return [] } })()) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    try {
      const top = fs.readdirSync(dir)
      if (top.length !== 1 || top[0] !== 'vault') continue
      const v = path.join(dir, 'vault')
      const inside = fs.readdirSync(v)
      const empty = (n) => { try { return fs.readdirSync(path.join(v, n)).length === 0 } catch { return true } }
      if (inside.every(n => n === 'meta.json' || ((n === 'blobs' || n === 'snapshots') && empty(n)))) {
        fs.rmSync(dir, { recursive: true, force: true }); removed++
      }
    } catch {}
  }
  return removed
}

// Old-style backups (folder copies with meta.json: manual ones and the two
// rolling auto slots) become snapshots once, then the old folders go.
function migrateLegacy(game) {
  const gdir = require('./saveBackup').existingGameDir(game.name, game.id != null ? String(game.id) : undefined)
  if (!gdir) return 0
  let entries = []
  try { entries = fs.readdirSync(gdir, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'vault' || e.name.startsWith('.')) continue
    const dir = path.join(gdir, e.name)
    const data = path.join(dir, 'data')
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch {}
    if (!fs.existsSync(data)) continue
    if (meta.gameId != null && game.id != null && String(meta.gameId) !== String(game.id)) continue
    try {
      const vault = vaultDir(game)
      const files = listSourceFiles([data])
      const entriesOut = files.map(f => ({ s: 0, p: f.p, h: storeBlob(vault, f.abs), n: f.n, m: f.m }))
      if (!entriesOut.length) continue
      const reason = String(meta.label || '').startsWith('auto') ? 'auto' : meta.label === 'before-restore' ? 'before-restore' : 'manual'
      const created = meta.createdAt || new Date(fs.statSync(dir).mtimeMs).toISOString()
      const snap = {
        id: `${created.replace(/[:.]/g, '-')}_${reason}_old`,
        gameId: game.id ?? null, gameName: game.name, createdAt: created, reason, label: 'From an older backup',
        sources: [meta.source || data], files: entriesOut, bytes: entriesOut.reduce((a, f) => a + f.n, 0),
      }
      const file = path.join(vault, 'snapshots', `${snap.id}.json`)
      fs.writeFileSync(file, JSON.stringify(snap))
      // Verify every blob before the old folder goes.
      for (const f of entriesOut) readBlob(vault, f.h)
      fs.rmSync(dir, { recursive: true, force: true })
      n++
    } catch (e) {
      logger.warn(`saveVault: could not import old backup ${dir}`, { message: e.message })
    }
  }
  return n
}

module.exports = {
  snapshot, listSnapshots, readSnapshotFor, targetsFor, restore, compare, exportSnapshot, remove, mapSource,
  prune, prunePolicy, gc, usage, enforceCap, capGb, syncMirror, migrateLegacy, mirrorRoot, cleanEmpty,
}
