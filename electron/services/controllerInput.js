'use strict'

// Gamepad activity probe (Windows XInput).
//
// Why: powerMonitor.getSystemIdleTime() only reflects keyboard/mouse, so a
// controller-only player would be falsely flagged AFK. There's no Node API for
// XInput, and the renderer Gamepad API can't poll while the window is hidden
// behind a fullscreen game. So we run ONE persistent PowerShell process that
// P/Invokes XInputGetState in a tight loop and prints a line whenever a
// connected controller is actively being used (button held, trigger pulled, or
// a stick pushed past a deadzone — raw stick drift is filtered out). Each line
// refreshes `lastInputAt`; `msSinceInput()` is then the controller's idle time.
//
// The C# is compiled once at process start, then the loop is cheap. The probe
// only runs while a game session is active AND the user enabled controller
// tracking (see processWatcher), so it isn't burning cycles at idle.

const { spawn } = require('child_process')
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const logger = require('../logger')

let proc        = null
let lastInputAt = 0
let scriptPath  = null

const PS_SCRIPT = `
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XIProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct GP { public ushort wButtons; public byte bLT; public byte bRT; public short LX; public short LY; public short RX; public short RY; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ST { public uint pkt; public GP pad; }
  [DllImport("xinput1_4.dll")] static extern int XInputGetState(int i, ref ST s);
  public static bool ActiveNow() {
    for (int i = 0; i < 4; i++) {
      ST s = new ST();
      int r;
      try { r = XInputGetState(i, ref s); } catch { return false; }
      if (r == 0) {
        GP g = s.pad;
        if (g.wButtons != 0) return true;
        if (g.bLT > 30 || g.bRT > 30) return true;
        if (Math.Abs((int)g.LX) > 9000 || Math.Abs((int)g.LY) > 9000) return true;
        if (Math.Abs((int)g.RX) > 9000 || Math.Abs((int)g.RY) > 9000) return true;
      }
    }
    return false;
  }
}
"@
while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  if ([XIProbe]::ActiveNow()) { [Console]::Out.WriteLine("C"); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 1000
}
`.trim()

function start() {
  if (proc) return
  if (process.platform !== 'win32') return   // XInput is Windows-only
  try {
    if (!scriptPath) {
      scriptPath = path.join(os.tmpdir(), 'kozo-controller-probe.ps1')
      fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')
    }
    proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, String(process.pid)],
      { windowsHide: true })
    lastInputAt = Date.now()                 // grace: treat as active at startup
    proc.stdout.on('data', () => { lastInputAt = Date.now() })
    proc.stderr.on('data', () => {})
    proc.on('exit', () => { proc = null })
    proc.on('error', (e) => { logger.warn('controllerInput spawn error: ' + e.message); proc = null })
    logger.info('controllerInput: gamepad activity probe started')
  } catch (e) {
    logger.warn('controllerInput.start: ' + e.message)
    proc = null
  }
}

function stop() {
  if (proc) { try { proc.kill() } catch {} proc = null }
}

// Milliseconds since the controller last reported activity. Infinity when the
// probe isn't running (so callers fall back to the keyboard/mouse idle time).
function msSinceInput() { return proc ? (Date.now() - lastInputAt) : Infinity }
function isRunning() { return !!proc }

module.exports = { start, stop, msSinceInput, isRunning }
