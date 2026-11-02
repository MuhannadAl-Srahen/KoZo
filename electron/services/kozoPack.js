'use strict'
// One file with everything (Backups → "Save everything to one file"): the
// library data plus every game's save history, for a new PC or a friend's.
// Format (no dependencies): "KOZOPACK1\n", a 4-byte big-endian index length,
// the JSON index { v, created, files: [{ p, n }] }, then each file's bytes in
// index order. Files are streamed in and out, so a large vault never sits in
// memory. The vault's blobs are already gzipped, so nothing is compressed here.

const fs = require('fs')
const path = require('path')

const MAGIC = Buffer.from('KOZOPACK1\n')

// Every file under `dir`, as forward-slash paths relative to it.
function listFiles(dir, prefix = '') {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(full, rel))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()))
  })
}

// entries: [{ p: 'Saves/x/y', from: absolute path } | { p, data: Buffer }]
async function writePack(outPath, entries, onProgress) {
  const files = entries.map(e => ({ p: e.p, n: e.data ? e.data.length : fs.statSync(e.from).size }))
  const index = Buffer.from(JSON.stringify({ v: 1, created: new Date().toISOString(), files }))
  const len = Buffer.alloc(4); len.writeUInt32BE(index.length)
  const tmp = outPath + '.part'
  const out = fs.createWriteStream(tmp)
  try {
    await writeChunk(out, MAGIC)
    await writeChunk(out, len)
    await writeChunk(out, index)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.data) await writeChunk(out, e.data)
      else {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(e.from)
          rs.on('error', reject)
          rs.on('end', resolve)
          rs.pipe(out, { end: false })
        })
      }
      onProgress?.(i + 1, entries.length)
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())))
  } catch (e) {
    out.destroy()
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  }
  fs.renameSync(tmp, outPath)
  return { files: files.length, bytes: fs.statSync(outPath).size }
}

function readIndex(fd) {
  const head = Buffer.alloc(MAGIC.length + 4)
  fs.readSync(fd, head, 0, head.length, 0)
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a KoZo backup file')
  const len = head.readUInt32BE(MAGIC.length)
  const buf = Buffer.alloc(len)
  fs.readSync(fd, buf, 0, len, head.length)
  return { index: JSON.parse(buf.toString('utf8')), start: head.length + len }
}

// Unpacks into `destFor(p)` (return null to skip a file). A path that tries to
// leave its folder ("..") is refused. Existing files are kept when `keep(p,
// dest)` says so (vault blobs are named by their hash: same name, same bytes).
function readPack(packPath, { destFor, keep = () => false, onProgress } = {}) {
  const fd = fs.openSync(packPath, 'r')
  try {
    const { index, start } = readIndex(fd)
    let pos = start
    const out = { files: 0, skipped: 0, data: null }
    const chunk = Buffer.alloc(1 << 20)
    index.files.forEach((f, i) => {
      const at = pos
      pos += f.n
      if (String(f.p).split('/').includes('..')) { out.skipped++; return }
      if (f.p === 'data.json') {
        const buf = Buffer.alloc(f.n)
        fs.readSync(fd, buf, 0, f.n, at)
        out.data = buf
        return
      }
      const dest = destFor(f.p)
      if (!dest || keep(f.p, dest)) { out.skipped++; return }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const wfd = fs.openSync(dest, 'w')
      try {
        let left = f.n, off = at
        while (left > 0) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, left), off)
          if (n <= 0) throw new Error('The KoZo file is cut short')
          fs.writeSync(wfd, chunk, 0, n)
          left -= n; off += n
        }
      } finally { fs.closeSync(wfd) }
      out.files++
      onProgress?.(i + 1, index.files.length)
    })
    return out
  } finally { fs.closeSync(fd) }
}

// The app's own pack: data.json (autoBackup's payload, no secrets or
// per-machine settings) and Saves/** from the save vault folder.
async function exportAll(outPath, onProgress) {
  const payload = require('./autoBackup').buildPayload()
  payload.auto = false
  const entries = [{ p: 'data.json', data: Buffer.from(JSON.stringify(payload)) }]
  const saves = require('./saveBackup').rootPath()
  if (saves && fs.existsSync(saves)) {
    for (const rel of listFiles(saves)) entries.push({ p: `Saves/${rel}`, from: path.join(saves, rel) })
  }
  const r = await writePack(outPath, entries, onProgress)
  return { ...r, games: (payload.games || []).length }
}

// Saves go into this PC's vault folder (blobs already there are kept); the
// data is written to a temp file for ipc's importBackupFile.
function importAll(packPath, onProgress) {
  const saves = require('./saveBackup').rootPath()
  const r = readPack(packPath, {
    destFor: (p) => (p.startsWith('Saves/') && saves ? path.join(saves, ...p.slice(6).split('/')) : null),
    keep: (p, dest) => /\/blobs\//.test(p) && fs.existsSync(dest),
    onProgress,
  })
  let dataPath = null
  if (r.data) {
    dataPath = path.join(require('os').tmpdir(), `kozo-pack-${Date.now()}.json`)
    fs.writeFileSync(dataPath, r.data)
  }
  return { files: r.files, skipped: r.skipped, dataPath }
}

module.exports = { writePack, readPack, listFiles, exportAll, importAll }
