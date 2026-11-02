'use strict'

// Open KoZo from the controller: hold a button combo for one second, from
// anywhere, even while KoZo sits closed in the tray. The combo is the setting
// `pad_wake_combo` (Settings > Shortcuts): the Xbox button (default),
// LB + RB + Menu, View + Menu, or off. The Xbox button is only reported by the
// undocumented XInputGetStateEx (ordinal 100); where that call is missing the
// Xbox choice falls back to LB + RB + Menu.
//
// The renderer Gamepad API can't see a pad while the window is hidden (or
// destroyed after 60s in the tray), so like controllerInput.js this runs ONE
// hidden PowerShell process that P/Invokes XInputGetState. It only reads the
// button word every 120 ms and prints "WAKE" once per one-second hold; the C#
// is compiled once at start. It checks every few seconds that KoZo is still
// alive and exits with it. Started at boot, restarted with backoff if it dies.

const { spawn } = require('child_process')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const logger = require('../logger')

const MENU  = 0x0010
const VIEW  = 0x0020
const LB    = 0x0100
const RB    = 0x0200
const GUIDE = 0x0400

const COMBOS = {
  guide:    GUIDE,
  lbrbmenu: LB | RB | MENU,
  viewmenu: VIEW | MENU,
}
const DEFAULT_COMBO = 'guide'
let combo = DEFAULT_COMBO

let proc = null
let scriptPath = null
let onWake = null
let restarts = 0
let restartTimer = null
let stopped = false

const PS_SCRIPT = `
param([int]$ParentPid = 0, [int]$Mask = 0, [int]$Fallback = 0)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XIWake {
  [StructLayout(LayoutKind.Sequential)]
  public struct GP { public ushort wButtons; public byte bLT; public byte bRT; public short LX; public short LY; public short RX; public short RY; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ST { public uint pkt; public GP pad; }
  [DllImport("xinput1_4.dll")] static extern int XInputGetState(int i, ref ST s);
  [DllImport("xinput1_4.dll", EntryPoint = "#100")] static extern int XInputGetStateEx(int i, ref ST s);
  static bool noEx = false;
  public static bool ComboHeld(int mask, int fallback) {
    for (int i = 0; i < 4; i++) {
      ST s = new ST();
      int r;
      if (!noEx) {
        try { r = XInputGetStateEx(i, ref s); } catch { noEx = true; continue; }
      } else {
        try { r = XInputGetState(i, ref s); } catch { return false; }
      }
      int m = (noEx && fallback != 0) ? fallback : mask;
      if (r == 0 && (s.pad.wButtons & m) == m) return true;
    }
    return false;
  }
}
"@
$heldSince = $null
$fired = $false
$tick = 0
while ($true) {
  $tick++
  if ($ParentPid -gt 0 -and ($tick % 40) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  if ([XIWake]::ComboHeld($Mask, $Fallback)) {
    if ($heldSince -eq $null) { $heldSince = [DateTime]::UtcNow }
    elseif (-not $fired -and ([DateTime]::UtcNow - $heldSince).TotalMilliseconds -ge 1000) {
      [Console]::Out.WriteLine("WAKE"); [Console]::Out.Flush(); $fired = $true
    }
  } else { $heldSince = $null; $fired = $false }
  Start-Sleep -Milliseconds 120
}
`.trim()

function spawnProbe() {
  if (proc || stopped || !COMBOS[combo]) return
  const mask = COMBOS[combo]
  const fallback = combo === 'guide' ? COMBOS.lbrbmenu : 0
  try {
    if (!scriptPath) {
      scriptPath = path.join(os.tmpdir(), 'kozo-controller-wake.ps1')
      fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')
    }
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, String(process.pid), String(mask), String(fallback)],
      { windowsHide: true })
    proc = child
    child.stdout.on('data', (buf) => {
      if (String(buf).includes('WAKE')) { try { onWake?.() } catch (e) { logger.warn('controllerWake: ' + e.message) } }
    })
    child.stderr.on('data', () => {})
    child.on('exit', () => {
      if (proc !== child) return
      proc = null
      if (stopped) return
      // Died on its own: try again later, waiting longer each time.
      const wait = Math.min(10 * 60 * 1000, 15000 * 2 ** Math.min(restarts++, 5))
      restartTimer = setTimeout(spawnProbe, wait)
    })
    child.on('error', (e) => {
      logger.warn('controllerWake spawn error: ' + e.message)
      if (proc === child) proc = null
    })
    logger.info('controllerWake: watcher started (' + combo + ')')
  } catch (e) {
    logger.warn('controllerWake.start: ' + e.message)
    proc = null
  }
}

function readCombo() {
  try {
    const v = require('../db/queries/settings').getSetting('pad_wake_combo')
    if (v === 'off' || COMBOS[v]) return v
  } catch {}
  return DEFAULT_COMBO
}

function start(handler) {
  if (process.platform !== 'win32') return   // XInput is Windows-only
  onWake = handler
  stopped = false
  combo = readCombo()
  spawnProbe()
}

// Settings > Shortcuts changed the combo: restart the watcher with it.
function setCombo(v) {
  if (process.platform !== 'win32') return
  const next = (v === 'off' || COMBOS[v]) ? v : DEFAULT_COMBO
  if (next === combo && (proc || next === 'off')) return
  combo = next
  clearTimeout(restartTimer)
  restarts = 0
  const old = proc
  proc = null
  if (old) { try { old.kill() } catch {} }
  if (onWake && !stopped) spawnProbe()
}

function stop() {
  stopped = true
  clearTimeout(restartTimer)
  if (proc) { try { proc.kill() } catch {} proc = null }
}

module.exports = { start, stop, setCombo }
