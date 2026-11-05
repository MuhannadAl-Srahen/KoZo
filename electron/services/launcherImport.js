// Games installed through other launchers, read from each launcher's own
// records (not by walking folders like Scan PC):
//
//   Epic   %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item (JSON)
//   GOG    HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id> (registry), with the
//          goggame-<id>.info files in the usual GOG folders as a fallback
//   Xbox   Get-AppxPackage entries whose folder holds MicrosoftGame.config
//          (Game Pass / Microsoft Store PC games)
//
// Results use the Scan PC shape ({ name, exe_name, install_path,
// detected_type, ... }) plus `launch_uri` for launchers that must start the
// game themselves (Epic sign-in, Xbox's protected WindowsApps folders).
// `exe_name` stays the process processWatcher looks for.
//
// The parse* functions are pure and covered by scripts/test-parsers.js.

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

// ── Epic ─────────────────────────────────────────────────────────────────────
function parseEpicManifest(json) {
  let m
  try { m = typeof json === 'string' ? JSON.parse(json) : json } catch { return null }
  if (!m || !m.DisplayName || !m.InstallLocation) return null
  if (m.bIsIncompleteInstall) return null
  // DLC and add-ons have their own manifests; only the base game counts.
  const cats = Array.isArray(m.AppCategories) ? m.AppCategories.map(String) : []
  if (cats.some(c => /addons|dlc/i.test(c)) && !cats.includes('games')) return null
  if (m.MainGameAppName && m.AppName && m.MainGameAppName !== m.AppName) return null
  const exe = m.LaunchExecutable ? path.win32.basename(String(m.LaunchExecutable)) : null
  const id = [m.CatalogNamespace, m.CatalogItemId, m.AppName].filter(Boolean)
  return {
    name: String(m.DisplayName).trim(),
    exe_name: exe,
    install_path: String(m.InstallLocation),
    detected_type: 'Epic',
    store_id: m.AppName || null,
    launch_uri: id.length === 3
      ? `com.epicgames.launcher://apps/${id.map(encodeURIComponent).join('%3A')}?action=launch&silent=true`
      : null,
  }
}

function readEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  let files = []
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.item')) } catch { return [] }
  const out = []
  for (const f of files) {
    try {
      const g = parseEpicManifest(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (g && fs.existsSync(g.install_path)) out.push(g)
    } catch {}
  }
  return out
}

// ── GOG ──────────────────────────────────────────────────────────────────────
// `reg query <key> /s` output: a key line, then "    name    REG_SZ    value".
function parseGogRegistry(text) {
  const blocks = []
  let cur = null
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      cur = { key: line.trim(), values: {} }
      blocks.push(cur)
      continue
    }
    const m = line.match(/^\s{2,}(\S.*?)\s{2,}REG_\w+\s{2,}(.*)$/) || line.match(/^\s{2,}(\S.*?)\s{2,}REG_\w+\s*$/)
    if (m && cur) cur.values[m[1].toLowerCase()] = (m[2] || '').trim()
  }
  const out = []
  for (const b of blocks) {
    const v = b.values
    const name = v.gamename || v.game_name
    if (!name || !v.path) continue
    if (v.dependson) continue              // DLC points at its base game
    const exe = v.exe ? path.win32.basename(v.exe) : null
    out.push({
      name: name.trim(),
      exe_name: exe,
      install_path: v.path,
      detected_type: 'GOG',
      store_id: v.gameid || null,
      // GOG games start fine from their own exe (doLaunch's normal path).
      launch_uri: null,
      _exe_full: v.exe || null,
    })
  }
  return out
}

// goggame-<id>.info: { name, playTasks: [{ isPrimary, path }] }
function parseGogInfo(json, folder) {
  let m
  try { m = typeof json === 'string' ? JSON.parse(json) : json } catch { return null }
  if (!m?.name) return null
  if (m.rootGameId && m.gameId && m.rootGameId !== m.gameId) return null   // DLC
  const task = (m.playTasks || []).find(t => t.isPrimary) || (m.playTasks || [])[0]
  return {
    name: String(m.name).trim(),
    exe_name: task?.path ? path.win32.basename(task.path) : null,
    install_path: folder,
    detected_type: 'GOG',
    store_id: m.gameId || null,
    launch_uri: null,
  }
}

function regQuery(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/s'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)))
  })
}

async function readGog() {
  const text = (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games')) || (await regQuery('HKLM\\SOFTWARE\\GOG.com\\Games'))
  let out = parseGogRegistry(text).filter(g => fs.existsSync(g.install_path))
  if (out.length) return out
  // No registry (GOG offline installers on another PC): look for .info files.
  const roots = []
  for (const d of 'CDEFGH') roots.push(`${d}:\\GOG Games`, `${d}:\\Program Files (x86)\\GOG Galaxy\\Games`, `${d}:\\Games\\GOG`)
  for (const root of roots) {
    let dirs = []
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { continue }
    for (const d of dirs) {
      const folder = path.join(root, d.name)
      try {
        const info = fs.readdirSync(folder).find(f => /^goggame-\d+\.info$/i.test(f))
        if (!info) continue
        const g = parseGogInfo(fs.readFileSync(path.join(folder, info), 'utf8'), folder)
        if (g) out.push(g)
      } catch {}
    }
  }
  return out
}

// ── Xbox ─────────────────────────────────────────────────────────────────────
function xmlAttr(xml, tag, attr) {
  const m = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1] : null
}

// One package: MicrosoftGame.config gives the name and the game's exe,
// AppxManifest.xml the application id that shell:AppsFolder needs.
function parseXboxPackage({ name, familyName, installLocation, gameConfig, appxManifest }) {
  let display = xmlAttr(gameConfig, 'ShellVisuals', 'DefaultDisplayName')
  if (!display || /^ms-resource:/i.test(display)) {
    const m = String(appxManifest || '').match(/<DisplayName>([^<]+)<\/DisplayName>/i)
    display = m && !/^ms-resource:/i.test(m[1]) ? m[1] : null
  }
  if (!display) {
    // Last resort: "Publisher.GameName" → "Game Name"
    display = String(name || '').split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2')
  }
  const exe = xmlAttr(gameConfig, 'Executable', 'Name')
  const appId = xmlAttr(appxManifest, 'Application', 'Id') || 'Game'
  if (!familyName || !display) return null
  return {
    name: display.trim(),
    exe_name: exe ? path.win32.basename(exe) : null,
    install_path: installLocation,
    detected_type: 'Xbox',
    store_id: familyName,
    launch_uri: `shell:AppsFolder\\${familyName}!${appId}`,
  }
}

function readXbox() {
  // Windows PowerShell: Get-AppxPackage doesn't load under PowerShell 7.
  const ps = `Get-AppxPackage | Where-Object { $_.InstallLocation -and (Test-Path -LiteralPath (Join-Path $_.InstallLocation 'MicrosoftGame.config')) } | Select-Object Name, PackageFamilyName, InstallLocation | ConvertTo-Json -Compress`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err || !String(out).trim()) return resolve([])
      let list
      try { list = JSON.parse(String(out)) } catch { return resolve([]) }
      if (!Array.isArray(list)) list = [list]
      const games = []
      for (const p of list) {
        try {
          const loc = p.InstallLocation
          const gameConfig = fs.readFileSync(path.join(loc, 'MicrosoftGame.config'), 'utf8')
          let appxManifest = ''
          try { appxManifest = fs.readFileSync(path.join(loc, 'AppxManifest.xml'), 'utf8') } catch {}
          const g = parseXboxPackage({ name: p.Name, familyName: p.PackageFamilyName, installLocation: loc, gameConfig, appxManifest })
          if (g) games.push(g)
        } catch {}
      }
      resolve(games)
    })
  })
}

// Every launcher at once; one failing never hides the others.
async function readAll() {
  const [epic, gog, xbox] = await Promise.all([
    Promise.resolve().then(readEpic).catch(() => []),
    readGog().catch(() => []),
    readXbox().catch(() => []),
  ])
  const seen = new Set()
  return [...epic, ...gog, ...xbox].filter(g => {
    const k = g.install_path.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).map(({ _exe_full, ...g }) => ({ ...g, steam_app_id: null, is_cracked: 0, isInstalled: true }))
}

// A stable key per found game, for "already reviewed" bookkeeping.
function keyOf(g) { return `${g.detected_type}:${(g.store_id || g.install_path || g.name).toLowerCase()}` }

// Pure: one list from a folder scan and the launchers' own records. A game in both is the
// launcher's, because that knows how to start it. Folder entries keep their place.
function mergeLauncherGames(results, found) {
  const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const out = [...results]
  for (const g of found) {
    const entry = { ...g, isInstalled: true }
    const at = g.install_path ? out.findIndex(r => norm(r.install_path) === norm(g.install_path)) : -1
    if (at >= 0) out[at] = entry
    else out.push(entry)
  }
  return out
}

module.exports = { readAll, keyOf, mergeLauncherGames, parseEpicManifest, parseGogRegistry, parseGogInfo, parseXboxPackage }
