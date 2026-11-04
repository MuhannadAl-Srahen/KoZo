'use strict'

// The one hidden PowerShell process that asks Windows what Node can't:
//   - the controller wake combo (controllerWake.js)
//   - whether a controller is being used, so controller play isn't AFK (controllerInput.js)
//   - which app is in front (foregroundProbe.js)
//
// The gamepad activity check used to be a second process of about 70 MB that started
// in the middle of a game, and a start costs a powershell.exe plus a C# compile
// (csc.exe, 1 to 2 s of CPU), which is exactly the kind of work a game feels. This
// one starts with KoZo, compiles once, and then a loop of a few cheap calls is all
// it does. It checks that KoZo is alive and exits with it.

const { spawn } = require('child_process')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const logger = require('../logger')

let proc = null
let scriptPath = null
let stopped = true
let restarts = 0
let restartTimer = null
let failedAt = 0
const RETRY_AFTER_MS = 5 * 60 * 1000

// Microsoft's XInput docs: don't poll an empty controller slot every frame, because
// the check for a device on a disconnected slot is the slow path. Only slots with
// a controller are read every tick; empty ones get a look about every 2 s.
const PS_SCRIPT = `
param([int]$ParentPid = 0, [int]$Mask = 0, [int]$Fallback = 0)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KozoProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct GP { public ushort wButtons; public byte bLT; public byte bRT; public short LX; public short LY; public short RX; public short RY; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ST { public uint pkt; public GP pad; }
  [DllImport("xinput1_4.dll")] static extern int XInputGetState(int i, ref ST s);
  [DllImport("xinput1_4.dll", EntryPoint = "#100")] static extern int XInputGetStateEx(int i, ref ST s);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static bool noEx = false;
  static bool[] empty = new bool[4];
  static int tick = 0;
  public static bool Held;
  public static bool Active;
  public static void Poll(int mask, int fallback) {
    Held = false;
    Active = false;
    bool recheck = (tick++ % 16) == 0;
    for (int i = 0; i < 4; i++) {
      if (empty[i] && !recheck) continue;
      ST s = new ST();
      int r;
      if (!noEx) {
        try { r = XInputGetStateEx(i, ref s); } catch { noEx = true; i--; continue; }
      } else {
        try { r = XInputGetState(i, ref s); } catch { return; }
      }
      empty[i] = r != 0;
      if (r != 0) continue;
      GP g = s.pad;
      int m = (noEx && fallback != 0) ? fallback : mask;
      if (m != 0 && (g.wButtons & m) == m) Held = true;
      if (g.wButtons != 0 || g.bLT > 30 || g.bRT > 30 ||
          Math.Abs((int)g.LX) > 9000 || Math.Abs((int)g.LY) > 9000 ||
          Math.Abs((int)g.RX) > 9000 || Math.Abs((int)g.RY) > 9000) Active = true;
    }
  }
  public static uint FrontPid() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint p;
    GetWindowThreadProcessId(h, out p);
    return p;
  }
}
"@
$tab = [char]9
$heldSince = $null
$fired = $false
$tick = 0
$lastActive = -100
$lastFront = 0
while ($true) {
  $tick++
  if ($ParentPid -gt 0 -and ($tick % 40) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  [KozoProbe]::Poll($Mask, $Fallback)
  if ([KozoProbe]::Held) {
    if ($heldSince -eq $null) { $heldSince = [DateTime]::UtcNow }
    elseif (-not $fired -and ([DateTime]::UtcNow - $heldSince).TotalMilliseconds -ge 1000) {
      [Console]::Out.WriteLine("WAKE"); [Console]::Out.Flush(); $fired = $true
    }
  } else { $heldSince = $null; $fired = $false }
  if ([KozoProbe]::Active -and ($tick - $lastActive) -ge 16) {
    $lastActive = $tick
    [Console]::Out.WriteLine("C"); [Console]::Out.Flush()
  }
  if (($tick % 16) -eq 0) {
    $front = [KozoProbe]::FrontPid()
    if ($front -ne 0 -and $front -ne $lastFront) {
      $lastFront = $front
      $p = Get-Process -Id $front
      [Console]::Out.WriteLine("F$tab$front$tab$($p.ProcessName)$tab$($p.Path)"); [Console]::Out.Flush()
    }
  }
  if (($tick % 240) -eq 0) { [Console]::Out.WriteLine("H"); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 120
}
`.trim()

// Anything still asking for it? Each feature can be turned off on its own.
function wanted() {
  try {
    if (require('./controllerWake').isOn()) return true
    const settingsQ = require('../db/queries/settings')
    const away = settingsQ.getSetting('away_pause_sec')
    if (away === null || away === undefined || away === '' || parseInt(away) > 0) return true
    return parseInt(settingsQ.getSetting('idle_pause_min')) > 0
  } catch { return true }
}

function onLine(line) {
  if (line === 'WAKE') require('./controllerWake').fire()
  else if (line === 'C') require('./controllerInput').noteInput()
  else require('./foregroundProbe').onLine(line)
}

function spawnProbe() {
  restartTimer = null
  if (proc || stopped || process.platform !== 'win32' || !wanted()) return
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return
  const { mask, fallback } = require('./controllerWake').masks()
  try {
    if (!scriptPath) {
      scriptPath = path.join(os.tmpdir(), 'kozo-desktop-probe.ps1')
      fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')
    }
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, String(process.pid), String(mask), String(fallback)],
      { windowsHide: true })
    proc = child
    let partial = ''
    child.stdout.on('data', (buf) => {
      const lines = (partial + String(buf)).split(/\r?\n/)
      partial = lines.pop()
      for (const line of lines) {
        try { onLine(line) } catch (e) { logger.warn('desktopProbe: ' + e.message) }
      }
    })
    child.stderr.on('data', () => {})
    // Only THIS child may clear the state: an old probe exiting late must not
    // orphan a newer one.
    child.on('exit', () => {
      if (proc !== child) return
      proc = null
      require('./foregroundProbe').reset()
      if (stopped) return
      // Died on its own: try again later, waiting longer each time.
      const wait = Math.min(10 * 60 * 1000, 15000 * 2 ** Math.min(restarts++, 5))
      restartTimer = setTimeout(spawnProbe, wait)
    })
    child.on('error', (e) => {
      logger.warn('desktopProbe spawn error: ' + e.message)
      failedAt = Date.now()
      if (proc === child) { proc = null; require('./foregroundProbe').reset() }
    })
    logger.info('desktopProbe: started')
  } catch (e) {
    logger.warn('desktopProbe.start: ' + e.message)
    proc = null
  }
}

function kill() {
  clearTimeout(restartTimer)
  restartTimer = null
  const old = proc
  proc = null
  if (old) { try { old.kill() } catch {} }
  require('./foregroundProbe').reset()
}

function start() {
  stopped = false
  spawnProbe()
}

// Settings changed the combo: its masks are launch arguments.
function restart() {
  if (stopped) return
  restarts = 0
  kill()
  spawnProbe()
}

// Run from the watcher's ticks: starts or stops it as settings turn features on and off.
function refresh() {
  if (stopped) return
  if (proc) { if (!wanted()) kill() }
  else if (!restartTimer) spawnProbe()
}

function stop() {
  stopped = true
  kill()
}

function isRunning() { return !!proc }

module.exports = { start, stop, restart, refresh, isRunning, PS_SCRIPT }
