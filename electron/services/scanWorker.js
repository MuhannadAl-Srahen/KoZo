'use strict'

// Runs one folder scan off the main thread. pcScanner is all synchronous disk
// walking (a whole drive can take a while), and on the main process that froze
// every window until it finished. Spawned by scanInWorker() below.

const { parentPort, workerData, isMainThread } = require('worker_threads')

if (!isMainThread && parentPort) {
  try {
    const { scanFolder } = require('./pcScanner')
    parentPort.postMessage({ ok: true, results: scanFolder(workerData.folder) })
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message })
  }
}

// Main-thread helper: scan `folder` in a worker; if a worker can't start (it
// should always be able to), scan in-process instead so a scan never fails.
function scanInWorker(folder) {
  return new Promise((resolve) => {
    const fallback = () => {
      try { resolve(require('./pcScanner').scanFolder(folder)) } catch { resolve([]) }
    }
    let worker
    try {
      const { Worker } = require('worker_threads')
      worker = new Worker(__filename, { workerData: { folder } })
    } catch { fallback(); return }
    let done = false
    worker.once('message', (m) => {
      done = true
      if (m?.ok) resolve(m.results || [])
      else fallback()
      worker.terminate().catch(() => {})
    })
    worker.once('error', () => { if (!done) { done = true; fallback() } })
    worker.once('exit', () => { if (!done) { done = true; fallback() } })
  })
}

module.exports = { scanInWorker }
