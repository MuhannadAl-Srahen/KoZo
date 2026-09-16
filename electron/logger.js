const fs = require('fs')
const path = require('path')
const { app } = require('electron')

let logStream = null
let logDate = null

function getLogStream() {
  // Re-derive per write — a tray session lives for weeks, so the stream must
  // roll to a new dated file at midnight instead of pinning to the launch day.
  const date = new Date().toISOString().slice(0, 10)
  if (logStream && logDate === date) return logStream
  if (logStream) { try { logStream.end() } catch {} }

  const logsDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })

  const logFile = path.join(logsDir, `kozo-${date}.log`)
  logStream = fs.createWriteStream(logFile, { flags: 'a' })
  logDate = date
  pruneOldLogs(logsDir)
  return logStream
}

// One file per day and nothing ever deleted them, so a tray install accumulated
// a file for every day it had ever run. Runs only when the stream rolls (first
// write of a new day), so this is at most one readdir per day.
const KEEP_LOG_DAYS = 14

function pruneOldLogs(logsDir) {
  try {
    const stale = fs.readdirSync(logsDir)
      .filter(f => /^kozo-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()                                   // filename sorts chronologically
      .slice(0, -KEEP_LOG_DAYS)
    for (const f of stale) {
      try { fs.unlinkSync(path.join(logsDir, f)) } catch (_) {}
    }
  } catch (_) {}
}

function formatLine(level, msg, data) {
  const ts = new Date().toISOString()
  const extra = data ? ' ' + JSON.stringify(data) : ''
  return `[${ts}] [${level}] ${msg}${extra}\n`
}

const logger = {
  info: (msg, data) => getLogStream().write(formatLine('INFO', msg, data)),
  warn: (msg, data) => getLogStream().write(formatLine('WARN', msg, data)),
  error: (msg, data) => getLogStream().write(formatLine('ERROR', msg, data)),
  debug: (msg, data) => {
    if (!app.isPackaged) getLogStream().write(formatLine('DEBUG', msg, data))
  },
}

module.exports = logger
