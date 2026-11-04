'use strict'

// Finds the folders that cloud sync apps keep on this PC, so Settings > Backups
// can offer them with one click. Whatever lands in one is uploaded by that app
// to the user's own storage. OneDrive is left out on purpose (the maker's
// choice); "Choose a folder" still takes any folder at all.

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// A disconnected drive letter can take many seconds to answer: never wait on one.
function isDir(p, ms = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    fs.promises.stat(p)
      .then(s => s.isDirectory(), () => false)
      .then((yes) => { clearTimeout(timer); resolve(yes) })
  })
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// Dropbox records its real location, which the user may have moved.
function dropboxPaths(env, home) {
  const out = []
  for (const dir of [env.APPDATA, env.LOCALAPPDATA]) {
    if (!dir) continue
    const info = readJson(path.join(dir, 'Dropbox', 'info.json'))
    if (info?.personal?.path) out.push(info.personal.path)
    if (info?.business?.path) out.push(info.business.path)
  }
  out.push(path.join(home, 'Dropbox'))
  return out
}

// Google Drive for Desktop streams as a drive letter (usually G:) with "My
// Drive" inside, or mirrors to a folder in the home folder.
function googleDrivePaths(home) {
  const out = [path.join(home, 'My Drive'), path.join(home, 'Google Drive')]
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) out.push(`${String.fromCharCode(c)}:\\My Drive`)
  return out
}

function candidates(env, home) {
  return [
    { id: 'google', name: 'Google Drive', paths: googleDrivePaths(home) },
    { id: 'dropbox', name: 'Dropbox', paths: dropboxPaths(env, home) },
    { id: 'mega', name: 'MEGA', paths: [
      path.join(home, 'MEGA'), path.join(home, 'MEGAsync'),
      path.join(home, 'Documents', 'MEGA'), path.join(home, 'Documents', 'MEGAsync'),
    ] },
    { id: 'icloud', name: 'iCloud Drive', paths: [path.join(home, 'iCloudDrive'), path.join(home, 'iCloud Drive')] },
  ]
}

// [{ id, name, path }], one per provider found, in a fixed order.
async function detect({ env = process.env, home = os.homedir() } = {}) {
  const found = await Promise.all(candidates(env, home).map(async (c) => {
    const hits = await Promise.all(c.paths.map(p => isDir(p)))
    const at = hits.indexOf(true)
    return at < 0 ? null : { id: c.id, name: c.name, path: c.paths[at] }
  }))
  return found.filter(Boolean)
}

module.exports = { detect, isDir }
