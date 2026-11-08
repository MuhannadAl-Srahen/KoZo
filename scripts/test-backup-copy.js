'use strict'

// Tests for the backup copy (services/backupCopy.js, cloudFolders.js and
// saveVault's mirror), in plain Node on throwaway folders. Never touches real
// KoZo data.
//
//   node scripts/test-backup-copy.js
//
// Exits 1 if anything fails.

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const root = path.join(__dirname, '..', 'electron')
// In the home folder, not Temp: KoZo rightly refuses Temp as a backup location.
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.kozo-copy-test-'))

// ── Stubs: settings in memory, no logging, a switchable "game running" ──────
const store = {}
let busy = false
const sentEvents = []
function stub(rel, exports) {
  const p = require.resolve(path.join(root, rel))
  require.cache[p] = { id: p, filename: p, loaded: true, exports }
}
stub('logger.js', { info() {}, warn() {}, error() {}, debug() {} })
stub('db/queries/settings.js', { getSetting: k => store[k], setSetting: (k, v) => { store[k] = v } })
const runningIds = new Set()
stub('services/processWatcher.js', { isSessionActive: () => busy, runWhenIdle: (_k, fn) => fn(), getActiveSessions: () => new Map([...runningIds].map(i => [i, {}])) })

const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: { getPath: () => tmp },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (c, d) => sentEvents.push([c, d]) } }] },
    }
  }
  return origLoad.call(this, req, ...rest)
}

const vault = require(path.join(root, 'services', 'saveVault.js'))
const copy = require(path.join(root, 'services', 'backupCopy.js'))
const { detect } = require(path.join(root, 'services', 'cloudFolders.js'))

let passed = 0, failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`) }
}
const exists = (...p) => fs.existsSync(path.join(...p))
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const tick = () => new Promise(r => setTimeout(r, 40))

// A local backups folder with one game: its files, as saveVault lays them out.
const base = path.join(tmp, 'local', 'KoZo Backup')
const saves = path.join(base, 'Saves')
const data = path.join(base, 'Data')
store.backup_base = base
store.saves_backup_dir = saves
store.auto_backup_dir = data
store.install_id = 'this-install'
write(path.join(saves, 'Game A', 'vault', 'blobs', 'aaa.gz'), 'blob-a')
write(path.join(saves, 'Game A', 'vault', 'snapshots', 's1.json'), '{"id":"s1"}')
write(path.join(saves, 'Game A', 'old-style', 'file.txt'), 'stays local')
write(path.join(data, 'kozo-autobackup.json'), '{"install":"this-install","games":[1,2]}')

async function main() {
  console.log('\nFirst copy')
  const cloud = path.join(tmp, 'cloud')
  fs.mkdirSync(cloud)
  const dest = copy.set(cloud)
  check('picked folder gets a KoZo Backup folder', dest === path.join(cloud, 'KoZo Backup'), dest)
  await copy.syncNow()
  await tick()
  check('blobs arrive', exists(dest, 'Saves', 'Game A', 'vault', 'blobs', 'aaa.gz'))
  check('snapshots arrive', exists(dest, 'Saves', 'Game A', 'vault', 'snapshots', 's1.json'))
  check('library file arrives', exists(dest, 'Data', 'kozo-autobackup.json'))
  check('old-style folders stay local', !exists(dest, 'Saves', 'Game A', 'old-style'))
  check('local backups stay', exists(saves, 'Game A', 'vault', 'blobs', 'aaa.gz'))
  check('no temp files left', !fs.readdirSync(path.join(dest, 'Data')).some(n => n.endsWith('.tmp')))
  check('base is unchanged', store.backup_base === base)
  check('status is broadcast', sentEvents.some(([c]) => c === 'backup:copyStatus'))
  let st = await copy.status()
  check('status reports a healthy copy', st.configured && st.reachable && !st.error && !!st.lastAt, JSON.stringify(st))

  console.log('\nLater changes')
  write(path.join(saves, 'Game A', 'vault', 'blobs', 'bbb.gz'), 'blob-b')
  await copy.syncNow()
  check('a new blob is copied', exists(dest, 'Saves', 'Game A', 'vault', 'blobs', 'bbb.gz'))

  const gameDirFn = path.join(saves, 'Game A', 'vault')
  write(path.join(dest, 'Saves', 'Game B', 'vault', 'blobs', 'ccc.gz'), 'from another PC')
  await copy.syncNow()
  check('saves only in the copy come down to this PC', exists(saves, 'Game B', 'vault', 'blobs', 'ccc.gz'))
  check('pull does not touch this game', exists(gameDirFn, 'blobs', 'aaa.gz'))

  console.log('\nReal snapshots')
  const game = { id: 7, name: 'Real Game' }
  const source = path.join(tmp, 'real-saves')
  write(path.join(source, 'slot1.sav'), 'save data')
  vault.snapshot(game, [source], 'manual')
  const realVault = path.join(saves, 'Real Game', 'vault')
  const snapFile = fs.readdirSync(path.join(realVault, 'snapshots')).find(n => n.endsWith('.json'))
  const copied = path.join(dest, 'Saves', 'Real Game', 'vault')
  check('a snapshot reaches the copy straight away', exists(copied, 'snapshots', snapFile), snapFile)
  check('with its blob', fs.readdirSync(path.join(copied, 'blobs')).some(n => n.endsWith('.gz')))
  vault.remove(game, snapFile.replace(/\.json$/, ''))
  check('deleting a snapshot deletes it from the copy', !exists(copied, 'snapshots', snapFile))
  write(path.join(source, 'slot1.sav'), 'newer save data')
  busy = true
  vault.snapshot(game, [source], 'manual')
  const midGame = fs.readdirSync(path.join(realVault, 'snapshots')).find(n => n.endsWith('.json'))
  check('nothing is copied while a game runs', !exists(copied, 'snapshots', midGame))
  busy = false
  await vault.syncMirror()
  check('it arrives after the game closes', exists(copied, 'snapshots', midGame))

  console.log('\nGame running')
  write(path.join(saves, 'Game A', 'vault', 'blobs', 'ddd.gz'), 'blob-d')
  busy = true
  const during = await vault.syncMirror()
  check('copy stops while a game runs', during.paused === true && !exists(dest, 'Saves', 'Game A', 'vault', 'blobs', 'ddd.gz'), JSON.stringify(during))
  busy = false
  await vault.syncMirror()
  check('and finishes afterwards', exists(dest, 'Saves', 'Game A', 'vault', 'blobs', 'ddd.gz'))

  console.log('\nLibrary file from another install')
  const destData = path.join(dest, 'Data', 'kozo-autobackup.json')
  fs.writeFileSync(destData, '{"install":"aaaaaa-other-pc","games":[1,2,3]}')
  await copy.copyData(path.join(data, 'kozo-autobackup.json'))
  const aside = fs.readdirSync(path.join(dest, 'Data')).filter(n => /^kozo-autobackup-.*aaaaaa\.json$/.test(n))
  check('kept beside, not overwritten', aside.length === 1, JSON.stringify(aside))
  check('this install now owns the main file', fs.readFileSync(destData, 'utf8').includes('this-install'))
  fs.writeFileSync(destData, '{"install":"bbbbbb-other-pc","games":[1]}')
  copy.copyDataSync(path.join(data, 'kozo-autobackup.json'))
  check('the quit flush follows the same rule', fs.readFileSync(destData, 'utf8').includes('this-install')
    && fs.readdirSync(path.join(dest, 'Data')).filter(n => /(aaaaaa|bbbbbb)\.json$/.test(n)).length === 2)

  console.log('\nRefusals')
  const refused = (fn) => { try { fn(); return false } catch { return true } }
  check('a folder inside the local backups is refused', refused(() => copy.set(path.join(base, 'inner'))))
  check('the local backups folder itself is refused', refused(() => copy.set(base)))
  check('a parent of the local backups is refused', refused(() => copy.set(path.join(tmp, 'local'))))
  check('Temp is refused', refused(() => copy.set(path.join(os.tmpdir(), 'somewhere'))))

  const home = require(path.join(root, 'services', 'backupHome.js'))
  const moved = refused(() => home.setBase(cloud))
  check('moving local backups onto the copy is refused', moved && store.backup_base === base)

  console.log('\nFolder that went away')
  store.backup_copy_dir = path.join(tmp, 'file-not-folder', 'KoZo Backup')
  write(path.join(tmp, 'file-not-folder'), 'a file, so nothing can be created below it')
  const gone = await copy.syncNow()
  check('reports unreachable instead of crashing', gone.error === 'unreachable', JSON.stringify(gone))
  st = await copy.status()
  check('status shows the problem', st.configured && !st.reachable && st.error === 'unreachable', JSON.stringify(st))
  store.backup_copy_dir = dest
  await copy.syncNow()
  st = await copy.status()
  check('clears once it is back', st.reachable && !st.error, JSON.stringify(st))

  console.log('\nRestore folder lookup')
  check('finds the folder itself', copy.resolveBackupFolder(dest) === dest)
  check('finds KoZo Backup inside', copy.resolveBackupFolder(cloud) === dest)
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty)
  check('says no when there is no backup', copy.resolveBackupFolder(empty) === null)

  console.log('\nStop copying')
  copy.off()
  st = await copy.status()
  check('stops', !st.configured)
  check('files stay', exists(dest, 'Saves', 'Game A', 'vault', 'blobs', 'aaa.gz'))
  const noCopy = await copy.syncNow()
  check('nothing runs afterwards', noCopy.copied === 0)

  console.log('\nThe older mirror setting still works')
  const legacy = path.join(tmp, 'legacy')
  store.save_mirror_dir = legacy
  await copy.syncNow()
  check('uses its KoZo Saves layout', exists(legacy, 'KoZo Saves', 'Game A', 'vault', 'blobs', 'aaa.gz'))
  store.save_mirror_dir = ''

  console.log('\nA game whose crack changed')
  {
    const cs = require(path.join(root, 'services', 'crackSaves.js'))
    const appData = path.join(tmp, 'crack-appdata')
    const savedEnv = process.env.APPDATA
    process.env.APPDATA = appData
    const gameDir = path.join(tmp, 'games', 'Halls of Torment')
    const game = { id: 77, name: 'Halls of Torment', steam_app_id: 2218750, install_path: gameDir, is_cracked: 1 }
    const gse = path.join(appData, 'GSE Saves', '2218750', 'remote')
    const progress = 'P'.repeat(92000)
    // Before the update: Goldberg, real progress in GSE Saves, backed up after play.
    fs.mkdirSync(path.join(gameDir, 'steam_settings'), { recursive: true })
    write(path.join(gse, 'HoT_profile.dat'), progress)
    check('Goldberg: its save folder is GSE Saves', cs.currentCloudFolder(game) === gse, cs.currentCloudFolder(game))
    const snap = vault.snapshot(game, [gse], 'after-play')
    check('the progress is backed up', !!snap.id, JSON.stringify(snap))
    // The update: TENOKE, which starts a fresh profile in SteamData beside the game.
    fs.rmSync(path.join(gameDir, 'steam_settings'), { recursive: true, force: true })
    write(path.join(gameDir, 'tenoke.ini'), '[TENOKE]\nid = 2218750\n')
    write(path.join(gameDir, 'SteamData', 'HoT_profile.dat'), 'fresh')
    const tenokeDir = path.join(gameDir, 'SteamData')
    check('TENOKE: its save folder is SteamData', cs.currentCloudFolder(game) === tenokeDir, cs.currentCloudFolder(game))
    const offer = cs.progressOffer(game)
    check('the progress is offered', offer && offer.id === snap.id && offer.crack === 'TENOKE', JSON.stringify(offer))
    runningIds.add(game.id)
    let refused = false
    try { vault.restore(game, offer.id) } catch (e) { refused = /Close Halls of Torment first/.test(e.message) }
    check('a restore waits until the game is closed', refused && fs.readFileSync(path.join(tenokeDir, 'HoT_profile.dat'), 'utf8') === 'fresh')
    runningIds.delete(game.id)
    const r = vault.restore(game, offer.id)
    check('the progress lands where the new crack reads', fs.readFileSync(path.join(tenokeDir, 'HoT_profile.dat'), 'utf8') === progress)
    check('the old crack\'s files are untouched', fs.readFileSync(path.join(gse, 'HoT_profile.dat'), 'utf8') === progress)
    const before = vault.listSnapshots(game).find(s => s.id === r.safety)
    check('what was there is kept as a restore point', !!before && before.reason === 'before-restore', JSON.stringify(before))
    check('nothing is offered once it is there', cs.progressOffer(game) === null)
    // "Not now" is remembered for this folder.
    write(path.join(tenokeDir, 'HoT_profile.dat'), 'fresh again')
    check('a fresh profile again is offered again', !!cs.progressOffer(game))
    cs.dismissOffer(game)
    check('"Not now" stops asking for this folder', cs.progressOffer(game) === null)
    process.env.APPDATA = savedEnv
  }

  console.log('\nFinding cloud folders')
  const fakeHome = path.join(tmp, 'home')
  const appData = path.join(tmp, 'appdata')
  const movedDropbox = path.join(tmp, 'D-drive', 'My Dropbox')
  fs.mkdirSync(movedDropbox, { recursive: true })
  write(path.join(appData, 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: movedDropbox } }))
  for (const d of ['OneDrive', 'OneDrive - Work', 'My Drive', 'MEGAsync', 'iCloudDrive']) fs.mkdirSync(path.join(fakeHome, d), { recursive: true })
  const found = await detect({ home: fakeHome, env: { APPDATA: appData, OneDrive: path.join(fakeHome, 'OneDrive') } })
  const byId = Object.fromEntries(found.map(f => [f.id, f.path]))
  check('Google Drive', byId.google === path.join(fakeHome, 'My Drive'), byId.google)
  check('Dropbox, at the place it recorded', byId.dropbox === movedDropbox, byId.dropbox)
  check('MEGA', byId.mega === path.join(fakeHome, 'MEGAsync'), byId.mega)
  check('iCloud', byId.icloud === path.join(fakeHome, 'iCloudDrive'), byId.icloud)
  check('never OneDrive', !found.some(f => /onedrive/i.test(f.path) || /onedrive/i.test(f.name)), JSON.stringify(found))
  const none = await detect({ home: path.join(tmp, 'no-home'), env: {} })
  check('nothing installed finds nothing', none.filter(f => f.id !== 'google').length === 0, JSON.stringify(none))

  console.log(`\n${passed} passed, ${failed} failed`)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
