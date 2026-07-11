'use strict'

// "Sign in with Steam" — real browser sign-in via Steam's OpenID endpoint, no
// server and no API key needed. Flow:
//   1. Spin up a one-shot local HTTP listener on 127.0.0.1 (random port).
//   2. Open steamcommunity.com/openid/login in the default browser.
//   3. Steam redirects back to the local listener with the claimed SteamID64.
//   4. Verify the assertion with Steam (check_authentication) so a forged
//      redirect can't spoof an identity, then save the id + persona name.
// Used as the fallback/switch-account path — the primary path is still the
// silent loginusers.vdf auto-detect, which needs zero interaction at all.

const http = require('http')
const logger = require('../logger')

let _active = null   // the in-flight sign-in's server, so a second click reuses/cancels

function settingsQ() { return require('../db/queries/settings') }

async function fetchPersona(steamId) {
  try {
    const axios = require('axios')
    const res = await axios.get(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
      timeout: 15000,
      responseType: 'text',
      transformResponse: [x => x],
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    return String(res.data).match(/<steamID>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/steamID>/i)?.[1] || ''
  } catch { return '' }
}

function signIn() {
  if (_active) {
    try { _active.close() } catch {}
    _active = null
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      _active = null
      resolve(result)
    }

    const server = http.createServer(async (req, res) => {
      let valid = false
      let steamId = null
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
        const params = url.searchParams
        steamId = (params.get('openid.claimed_id') || '').match(/\/openid\/id\/(7656\d{13})/)?.[1] || null

        // Verify the assertion with Steam — never trust the redirect alone.
        if (steamId && params.get('openid.mode') === 'id_res') {
          const body = new URLSearchParams()
          for (const [k, v] of params) body.set(k, v)
          body.set('openid.mode', 'check_authentication')
          const axios = require('axios')
          const check = await axios.post('https://steamcommunity.com/openid/login', body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
          })
          valid = /is_valid\s*:\s*true/i.test(String(check.data))
        }
      } catch (e) {
        logger.warn('steamOpenId: callback failed', { message: e.message })
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body style="margin:0;background:#0e0e1a;color:#ececf8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>${valid ? '✅ Signed in to KoZo' : '❌ Sign-in failed'}</h2><p style="color:#7878a0">${valid ? 'You can close this tab and return to KoZo.' : 'Return to KoZo and try again.'}</p></div></body></html>`)
      try { server.close() } catch {}

      if (valid && steamId) {
        settingsQ().setSetting('steam_user_id', steamId)
        const persona = await fetchPersona(steamId)
        if (persona) settingsQ().setSetting('steam_persona', persona)
        logger.info(`steamOpenId: signed in as ${persona || steamId}`)
        finish({ steamId, personaName: persona })
      } else {
        finish({ error: 'verify_failed' })
      }
    })

    server.on('error', (e) => {
      logger.warn('steamOpenId: local listener failed', { message: e.message })
      finish({ error: 'listener_failed' })
    })

    server.listen(0, '127.0.0.1', () => {
      _active = server
      const port = server.address().port
      const returnTo = `http://127.0.0.1:${port}/callback`
      const q = new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': `http://127.0.0.1:${port}`,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      })
      require('electron').shell.openExternal(`https://steamcommunity.com/openid/login?${q.toString()}`)
    })

    // Give up after 5 minutes if the user abandons the browser tab.
    const t = setTimeout(() => {
      try { server.close() } catch {}
      finish({ error: 'timeout' })
    }, 5 * 60 * 1000)
    t.unref?.()
  })
}

module.exports = { signIn }
