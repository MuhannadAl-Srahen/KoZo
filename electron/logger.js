const fs = require('fs')
const path = require('path')
const { app } = require('electron')

let logStream = null

function getLogStream() {
  if (logStream) return logStream

  const logsDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })

  const date = new Date().toISOString().slice(0, 10)
  const logFile = path.join(logsDir, `kozo-${date}.log`)
  logStream = fs.createWriteStream(logFile, { flags: 'a' })
  return logStream
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
