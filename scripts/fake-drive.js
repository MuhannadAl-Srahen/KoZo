'use strict'

// A pretend Google Drive for tests: the real googleDrive.js code runs and only the network
// is replaced, so no account, no internet and nothing on anyone's real Drive. install()
// swaps the `axios` module (googleDrive.js asks for it on every call); anything that isn't
// Google still goes to the real one. Files can be saved to disk, so one test process can
// play the PC and the next the laptop.

const fs = require('fs')

function createFakeDrive() {
  let nextId = 1
  const files = new Map()   // id -> { id, name, parents, mimeType, trashed, data: Buffer }
  const calls = { upload: [], download: [], remove: [] }

  const add = (meta, data = Buffer.alloc(0)) => {
    const id = `fake${nextId++}`
    files.set(id, { id, name: meta.name, parents: meta.parents || [], mimeType: meta.mimeType || 'application/octet-stream', trashed: false, data })
    return id
  }
  const parseMultipart = (body) => {
    const raw = Buffer.from(body)
    const sep = Buffer.from('\r\n\r\n')
    const metaAt = raw.indexOf(sep) + sep.length
    const metaEnd = raw.indexOf('\r\n--', metaAt)
    const meta = JSON.parse(raw.slice(metaAt, metaEnd).toString('utf8'))
    const dataAt = raw.indexOf(sep, metaEnd) + sep.length
    const boundary = raw.slice(2, raw.indexOf('\r\n')).toString()
    const dataEnd = raw.lastIndexOf(`\r\n--${boundary}--`)
    return { meta, data: raw.slice(dataAt, dataEnd) }
  }

  async function request({ method = 'get', url, params = {}, data }) {
    const m = String(method).toLowerCase()
    const u = new URL(url)
    if (u.pathname === '/token') return { data: { access_token: 'fake', expires_in: 3600, refresh_token: 'fake' } }
    if (u.pathname === '/revoke') return { data: {} }
    if (u.pathname.endsWith('/about')) return { data: { user: { emailAddress: 'someone@example.com' }, storageQuota: { limit: String(15 * 1024 ** 3), usage: '0' } } }
    if (u.pathname.startsWith('/upload/')) {
      const id = u.pathname.split('/files/')[1]
      const { meta, data: bytes } = parseMultipart(data)
      if (m === 'patch') {
        files.get(id).data = bytes
        calls.upload.push({ name: files.get(id).name, replaced: true })
        return { data: { id, size: bytes.length } }
      }
      calls.upload.push({ name: meta.name, replaced: false })
      return { data: { id: add(meta, bytes), size: bytes.length } }
    }
    const id = u.pathname.split('/files/')[1]
    if (id) {
      const f = files.get(id)
      if (!f) { const e = new Error('Not found'); e.response = { status: 404 }; throw e }
      if (m === 'delete') { files.delete(id); calls.remove.push(f.name); return { data: {} } }
      if (params.alt === 'media') {
        calls.download.push(f.name)
        return { data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.length) }
      }
      return { data: { id: f.id, trashed: f.trashed } }
    }
    if (m === 'post') return { data: { id: add(data) } }
    // Listing: the two queries googleDrive.js makes.
    const q = String(params.q || '')
    const parent = /'([^']+)' in parents/.exec(q)?.[1]
    const name = /name='([^']+)'/.exec(q)?.[1]
    const list = [...files.values()].filter(f => !f.trashed && (parent ? f.parents.includes(parent) : f.name === name))
    return { data: { files: list.map(f => ({ id: f.id, name: f.name, size: String(f.data.length) })) } }
  }

  return {
    request, files, calls, add,
    names: () => [...files.values()].map(f => f.name),
    read: (name) => { for (const f of files.values()) if (f.name === name) return f.data; return null },
    save(file) { fs.writeFileSync(file, JSON.stringify({ nextId, files: [...files.values()].map(f => ({ ...f, data: f.data.toString('base64') })) })) },
    load(file) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      nextId = j.nextId
      files.clear()
      for (const f of j.files) files.set(f.id, { ...f, data: Buffer.from(f.data, 'base64') })
    },
  }
}

// Swap the axios module for one that answers Google's addresses from `drive`. Returns undo.
function install(drive, axiosPath = require.resolve('axios')) {
  const real = require(axiosPath)
  const isGoogle = (url) => /googleapis\.com/.test(String(url))
  const fake = (config) => (isGoogle(config.url) ? drive.request(config) : real(config))
  Object.assign(fake, real)
  fake.post = (url, data, config) => (isGoogle(url) ? drive.request({ method: 'post', url, data, ...config }) : real.post(url, data, config))
  fake.get = (url, config) => (isGoogle(url) ? drive.request({ method: 'get', url, ...config }) : real.get(url, config))
  const cached = require.cache[axiosPath]
  const had = cached.exports
  cached.exports = fake
  return () => { cached.exports = had }
}

module.exports = { createFakeDrive, install }
