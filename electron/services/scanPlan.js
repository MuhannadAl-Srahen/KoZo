'use strict'

// Scan PC and games that are already in KoZo.
//
// The scan used to know two answers: "new, can be added" or "already in the Library, nothing
// to do". So a game removed earlier and installed again could not be brought back, a game with
// a wrong game file stayed wrong, and a game installed again into another folder stayed dimmed.
// Here each scan result is matched to its Library row and compared with it:
//   auto   changes that are certain, applied by the scan itself (never for a removed game):
//          "it is installed again" and "the same file, in another folder".
//   offer  changes shown on the card and applied only when the user ticks it: bring a removed
//          game back, a new folder, a better game file.
// A tool or an uncertain file is never set as the game file by itself (the user's rule: a
// wrong file is worse than none), and the user's own pick always wins.

const { sameGameFolder, isHelperExe } = require('./pcScanner')
const { nameKey } = require('./steamGridDb')

const low = (s) => String(s || '').toLowerCase()
const PLACEHOLDER_EXE = /^steam_\d+\.exe$/i

// The Library row a scan result is: the same folder, then the same Steam id, then the same
// words in the name. Among several, one that isn't removed wins, then the most played.
function matchRow(result, rows, taken = new Set()) {
  const free = (rows || []).filter(r => !taken.has(r.id))
  const best = (list) => list.slice().sort((a, b) =>
    (a.is_archived ? 1 : 0) - (b.is_archived ? 1 : 0) || (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0))[0] || null
  const byFolder = free.filter(r => r.install_path && (sameGameFolder(r.install_path, result.install_path) || sameGameFolder(r.install_path, result.game_root)))
  if (byFolder.length) return { row: best(byFolder), by: 'folder' }
  const byId = result.steam_app_id ? free.filter(r => r.steam_app_id && String(r.steam_app_id) === String(result.steam_app_id)) : []
  if (byId.length) return { row: best(byId), by: 'steam' }
  const key = nameKey(result.name)
  const byName = key ? free.filter(r => nameKey(r.name) === key) : []
  if (byName.length) return { row: best(byName), by: 'name' }
  return null
}

// What the scan found, compared with what the Library row says.
// exists(path) and driveGone(path) are passed in (the tests give their own).
function planChanges(result, row, { exists = () => false, driveGone = () => false } = {}) {
  const auto = {}, offer = {}
  if (!result || !row) return { auto, offer }
  const choices = result.exe_choices || []
  const rowExe = low(row.exe_name)
  const rowChoice = rowExe ? choices.find(c => low(c.exe_name) === rowExe) : null
  const root = result.game_root || result.install_path
  const fromFiles = result.detected_type === 'Cracked'
  const folderThere = !!row.install_path && exists(row.install_path)
  const same = !!row.install_path && (sameGameFolder(row.install_path, result.install_path) || sameGameFolder(row.install_path, root))
  const offline = !!row.install_path && !folderThere && driveGone(row.install_path)
  // Where the row should point: the folder of its own game file when the scan saw that file.
  const newPath = rowChoice ? (fromFiles ? rowChoice.dir : root) : result.install_path
  const hasGame = !result.no_game_file
  const archived = !!row.is_archived

  if (!archived) {
    if (!row.is_installed && folderThere && same && hasGame) auto.installed = true
    else if (!folderThere && !offline && rowChoice && low(newPath) !== low(row.install_path)) auto.folder = { from: row.install_path || '', to: newPath }
    // A game added without a folder or a file (from its saved achievements): the scan gives it both.
    else if (!row.install_path && !row.exe_name && hasGame && !result.exe_unsure && result.exe_name && !isHelperExe(result.exe_name)) {
      auto.folder = { from: '', to: result.install_path, exe: result.exe_name }
    }
  }

  if (archived) offer.restore = true
  const moved = !folderThere && !offline && !auto.folder && low(newPath) !== low(row.install_path)
  if (hasGame && (moved || (archived && !same))) offer.folder = { from: row.install_path || '', to: newPath }
  if (hasGame && !row.is_installed && !auto.installed && !auto.folder && !offline) offer.installed = true

  // A better game file: only a sure one, never over a file the user starts the game from.
  const pick = choices.find(c => low(c.exe_name) === low(result.exe_name))
  const pickOk = hasGame && !!result.exe_name && !result.exe_unsure && !result.launch_uri && !isHelperExe(result.exe_name)
  const keepsLauncher = !!row.launch_file && exists(row.launch_file)
  if (pickOk && !keepsLauncher && low(result.exe_name) !== rowExe && !auto.folder?.exe) {
    const rowIsTool = !!rowExe && isHelperExe(row.exe_name)
    if (!rowExe || PLACEHOLDER_EXE.test(row.exe_name) || !rowChoice || (rowIsTool && pick?.sure)) {
      offer.exe = { from: row.exe_name || '', to: result.exe_name, dir: pick?.dir || result.install_path }
      // A game without a launcher lives where its file is.
      if (fromFiles && offer.folder) offer.folder.to = offer.exe.dir
    }
  }
  return { auto, offer }
}

// The change to save for one ticked card. change: { restore, install_path, exe_name, exe_dir,
// launch_file, picked }. The status is never touched, and neither is the Steam id.
function patchFor(row, change, { exists = () => false } = {}) {
  const patch = {}
  if (change.restore) patch.is_archived = 0
  const newPath = change.install_path || null
  const pathChanged = !!newPath && low(newPath) !== low(row.install_path)
  if (newPath) { patch.install_path = newPath; patch.is_installed = 1 }
  else if (change.installed) patch.is_installed = 1
  if (change.exe_name && low(change.exe_name) !== low(row.exe_name)) patch.exe_name = change.exe_name
  if (change.launch_file !== undefined) patch.launch_file = change.launch_file || null
  else if (row.launch_file && (pathChanged || patch.exe_name)) {
    // The file it started from: kept only while it is still there, inside the game's folder.
    const inside = newPath ? sameGameFolder(newPath, row.launch_file) || low(row.launch_file).startsWith(low(newPath) + '\\') : true
    if (!exists(row.launch_file) || !inside) patch.launch_file = null
  }
  if (pathChanged && row.crack_dir && row.install_path && low(row.crack_dir).startsWith(low(row.install_path))) patch.crack_dir = null
  return patch
}

// The card's state in the results window.
function scanState(r) {
  const has = (o) => !!o && Object.keys(o).length > 0
  if (r?.library) return has(r.changes) ? 'update' : 'in-library'
  if (r?.no_game_file) return 'no-file'
  if (r?.exe_unsure) return 'unsure'
  return 'new'
}

module.exports = { matchRow, planChanges, patchFor, scanState }
