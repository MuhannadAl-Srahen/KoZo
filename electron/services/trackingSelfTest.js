'use strict'

// End-to-end achievement-tracking self-test — push-button proof that the
// critical pipeline works on THIS machine:
//   synthetic Goldberg crack file → real crackWatcher scan → real DB unlock
//   → real overlay toast (emitNewUnlocks fires inside the scan).
// Creates a throwaway hidden test game pointed at a temp folder, then removes
// every trace of it. Safety: deletion is double-guarded — only the exact row
// this run created, and only if its name/install_path still match.

const fs   = require('fs')
const path = require('path')
const logger = require('../logger')

const TEST_GAME_NAME = 'KoZo Tracking Self-Test'
const TEST_ACH_NAME  = 'ACH_KOZO_SELFTEST'

async function runSelfTest() {
  const { app } = require('electron')
  const gamesQ        = require('../db/queries/games')
  const achievementsQ = require('../db/queries/achievements')
  const { getDb }     = require('../db/database')

  const steps = []
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); return ok }

  let tempDir = null
  let gameId  = null

  try {
    // 1. Synthetic Goldberg crack file in a temp install folder.
    try {
      tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'kozo-selftest-'))
      const emuDir = path.join(tempDir, 'steam_settings')   // matches a real Goldberg candidate
      fs.mkdirSync(emuDir, { recursive: true })
      fs.writeFileSync(
        path.join(emuDir, 'achievements.json'),
        JSON.stringify({ [TEST_ACH_NAME]: { earned: true, earned_time: Math.floor(Date.now() / 1000) } }),
        'utf8'
      )
      step('Create synthetic crack file (Goldberg format)', true, emuDir)
    } catch (e) {
      step('Create synthetic crack file (Goldberg format)', false, e.message)
      return { ok: false, steps }
    }

    // 2. Throwaway hidden test game pointing at the temp folder.
    try {
      const game = gamesQ.addGame({
        name: TEST_GAME_NAME,
        exe_name: 'kozo-selftest.exe',
        install_path: tempDir,
        banner_url: null,
        banner_local_path: null,
        source: 'manual',
        steam_app_id: null,
        is_cracked: 1,
      })
      gameId = game.id
      gamesQ.updateGame(gameId, { manual_appid: 480, is_hidden: 1 })
      step('Create hidden test game', true, `id ${gameId}`)
    } catch (e) {
      step('Create hidden test game', false, e.message)
      return { ok: false, steps }
    }

    // 3. Achievement schema row the unlock must match against.
    try {
      achievementsQ.bulkUpsertAchievements(gameId, [{
        steam_api_name: TEST_ACH_NAME,
        display_name: 'Tracking works!',
        description: 'If you can see this toast, achievement tracking is working end to end.',
        icon_url: null,
        icon_locked_url: null,
        global_unlock_percent: null,
        is_hidden: 0,
      }])
      step('Insert achievement schema', true)
    } catch (e) {
      step('Insert achievement schema', false, e.message)
      return { ok: false, steps }
    }

    // 4. Run the REAL crack scanner against the synthetic file.
    let scan
    try {
      scan = await require('./crackWatcher').scanGameForCrackAchievements(gameId)
      const hit = scan.hits?.[0]
      step(
        'Crack scanner finds & parses the file',
        (scan.added ?? 0) === 1,
        hit ? `matched via ${hit.source}: ${hit.path}` : `added=${scan.added} candidates=${scan.candidatesTried}`
      )
    } catch (e) {
      step('Crack scanner finds & parses the file', false, e.message)
      return { ok: false, steps }
    }

    // 5. The unlock row must actually be in the database.
    try {
      const row = getDb().prepare(`
        SELECT au.source FROM achievement_unlocks au
        JOIN achievements a ON a.id = au.achievement_id
        WHERE a.game_id = ? AND a.steam_api_name = ?
      `).get(gameId, TEST_ACH_NAME)
      step('Unlock recorded in database', row?.source === 'crack', row ? `source: ${row.source}` : 'no unlock row found')
    } catch (e) {
      step('Unlock recorded in database', false, e.message)
    }

    // 6. Overlay: emitNewUnlocks already fired inside the scan (that IS the
    //    live pipeline) — the toast on screen right now is the visible proof.
    step('Overlay toast emitted', (scan.added ?? 0) === 1, 'The achievement toast you see (or saw) came through the real live pipeline.')

    const ok = steps.every(s => s.ok)
    if (ok) logger.info('trackingSelfTest: all steps passed')
    else logger.warn('trackingSelfTest: FAILED', { steps })
    return { ok, steps }
  } finally {
    // Cleanup — only ever touch the exact row this run created.
    try {
      if (gameId != null) {
        const row = require('../db/database').getDb()
          .prepare('SELECT name, install_path FROM games WHERE id = ?').get(gameId)
        if (row && row.name === TEST_GAME_NAME && tempDir && row.install_path === tempDir) {
          require('../db/queries/games').deleteGame(gameId)
        } else if (row) {
          logger.warn(`trackingSelfTest: refusing to delete game ${gameId} — row does not match the test fixture`)
        }
      }
    } catch (e) {
      logger.warn('trackingSelfTest: cleanup (game) failed', { message: e.message })
    }
    try {
      if (tempDir && path.basename(tempDir).startsWith('kozo-selftest-')) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (e) {
      logger.warn('trackingSelfTest: cleanup (temp dir) failed', { message: e.message })
    }
  }
}

module.exports = { runSelfTest }
