'use strict'

// The one hidden PowerShell process that asks Windows what Node can't:
//   - the controller wake combo (controllerWake.js), the connected controller slots, and
//     the buttons held while Settings records a combo
//   - whether a controller is being used, so controller play isn't AFK (controllerInput.js)
//   - which app is in front (foregroundProbe.js)
//   - when a library game's exe starts (S) and when a session's process exits (X), so a
//     session starts and ends in about a second instead of waiting for the next process
//     scan (processWatcher.js). The exit is read from a SYNCHRONIZE handle, which Windows
//     gives for a game running as administrator too: Node's process.kill(pid, 0) can't
//     tell such a game from a running one (EPERM), so its sessions used to end only at
//     the next full scan, a minute or two after quitting.
//   - bringing KoZo's window in front of a game (FOCUS), which Electron can't do on Windows
//
// The gamepad activity check used to be a second process of about 70 MB that started
// in the middle of a game, and a start costs a powershell.exe plus a C# compile
// (csc.exe, 1 to 2 s of CPU), which is exactly the kind of work a game feels. This
// one starts with KoZo, compiles once, and then a loop of a few cheap calls is all
// it does. It exits with KoZo (its stdin closes, and it also watches KoZo's process).
//
// Lines KoZo sends on stdin (tab separated):
//   N <exe> <exe> ...        the library's exe names to watch for (lowercase, with .exe)
//   W <pid> <pid> ...        the processes of the running sessions
//   M <mask> <fallback> <ms> the wake combo, the second combo that also works, the hold time
//   REC 1|0                  report the held buttons (B lines) while Settings records a combo
//   FOCUS <hwnd>             bring this window to the front
// Lines it prints:
//   WAKE, C, F <pid> <name> <path>, H (heartbeat), S <pid> <exe>, X <pid>,
//   U <pid> <error> (a session process it can't watch), P+<slot> / P-<slot>,
//   B <buttons>, FOCUSED 1|0

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

// What the probe is told, kept so a restarted probe is told again.
let watchNames = []
let watchPids = []
let recording = false

// Microsoft's XInput docs: don't poll an empty controller slot every frame, because
// the check for a device on a disconnected slot is the slow path. Only slots with
// a controller are read every tick; empty ones get a look about every 2 s.
const PS_SCRIPT = `
param([int]$ParentPid = 0, [int]$Mask = 0, [int]$Fallback = 0, [int]$HoldMs = 1000)
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$src = @"
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class KozoProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct GP { public ushort wButtons; public byte bLT; public byte bRT; public short LX; public short LY; public short RX; public short RY; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ST { public uint pkt; public GP pad; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PE32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("xinput1_4.dll")] static extern int XInputGetState(int i, ref ST s);
  [DllImport("xinput1_4.dll", EntryPoint = "#100")] static extern int XInputGetStateEx(int i, ref ST s);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", ExactSpelling = true, CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll", EntryPoint = "Process32NextW", ExactSpelling = true, CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", ExactSpelling = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);

  const uint SYNCHRONIZE = 0x00100000;
  const uint QUERY_LIMITED = 0x1000;
  static readonly object outLock = new object();
  static readonly ConcurrentQueue<string> cmds = new ConcurrentQueue<string>();
  static bool noEx = false;
  static int[] slot = new int[] { -1, -1, -1, -1 };   // -1 not known yet, 0 empty, 1 connected
  static int pollTick = 0;
  static bool Held;
  static bool Active;
  static int Buttons;
  static int mask, fallback, holdMs;
  static bool rec = false;
  static int lastButtons = -1;
  static HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static HashSet<uint> seen = null;
  static Dictionary<uint, IntPtr> watched = new Dictionary<uint, IntPtr>();

  static void Emit(string line) {
    lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  static void StartInput() {
    Thread t = new Thread(() => {
      try {
        StreamReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = r.ReadLine()) != null) cmds.Enqueue(line);
      } catch {}
      cmds.Enqueue("EOF");
    });
    t.IsBackground = true;
    t.Start();
  }

  static void Poll() {
    Held = false;
    Active = false;
    Buttons = 0;
    bool recheck = (pollTick++ % 16) == 0;
    for (int i = 0; i < 4; i++) {
      if (slot[i] == 0 && !recheck) continue;
      ST s = new ST();
      int r;
      if (!noEx) {
        try { r = XInputGetStateEx(i, ref s); } catch { noEx = true; i--; continue; }
      } else {
        try { r = XInputGetState(i, ref s); } catch { return; }
      }
      int now = r == 0 ? 1 : 0;
      if (now != slot[i]) {
        if (now == 1) Emit("P+" + i);
        else if (slot[i] == 1) Emit("P-" + i);
        slot[i] = now;
      }
      if (r != 0) continue;
      GP g = s.pad;
      int b = g.wButtons;
      Buttons |= b;
      // Both combos work: a pad that doesn't report the Xbox button (or a press that Game Bar
      // or Steam takes) still wakes KoZo with the second one.
      if (mask != 0 && (b & mask) == mask) Held = true;
      if (fallback != 0 && (b & fallback) == fallback) Held = true;
      if (b != 0 || g.bLT > 30 || g.bRT > 30 ||
          Math.Abs((int)g.LX) > 9000 || Math.Abs((int)g.LY) > 9000 ||
          Math.Abs((int)g.RX) > 9000 || Math.Abs((int)g.RY) > 9000) Active = true;
    }
  }

  static string ImagePath(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      StringBuilder sb = new StringBuilder(1024);
      int n = sb.Capacity;
      return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : "";
    } finally { CloseHandle(h); }
  }

  static void Front(ref uint lastFront) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0 || pid == lastFront) return;
    lastFront = pid;
    string p = ImagePath(pid);
    string name = "";
    if (p.Length > 0) name = Path.GetFileNameWithoutExtension(p);
    else { try { name = Process.GetProcessById((int)pid).ProcessName; } catch {} }
    Emit("F\t" + pid + "\t" + name + "\t" + p);
  }

  // Which watched exes started since the last look. The first look only learns what runs.
  // Windows building the snapshot is the cost (about 8 ms for ~300 processes), so it runs
  // every 2 s with no game and every 4 s during one (Run), not on every tick.
  static void Snapshot() {
    if (names.Count == 0) { seen = null; return; }
    IntPtr h = CreateToolhelp32Snapshot(2, 0);
    if (h == IntPtr.Zero || h == new IntPtr(-1)) return;
    HashSet<uint> now = new HashSet<uint>();
    try {
      PE32 e = new PE32();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
      if (Process32First(h, ref e)) {
        do {
          string exe = e.szExeFile;
          if (exe != null && names.Contains(exe)) {
            now.Add(e.th32ProcessID);
            if (seen != null && !seen.Contains(e.th32ProcessID)) Emit("S\t" + e.th32ProcessID + "\t" + exe.ToLowerInvariant());
          }
        } while (Process32Next(h, ref e));
      }
    } finally { CloseHandle(h); }
    seen = now;
  }

  static void SetWatch(string[] parts) {
    HashSet<uint> want = new HashSet<uint>();
    for (int i = 1; i < parts.Length; i++) { uint p; if (uint.TryParse(parts[i], out p) && p > 0) want.Add(p); }
    foreach (KeyValuePair<uint, IntPtr> kv in new List<KeyValuePair<uint, IntPtr>>(watched)) {
      if (!want.Contains(kv.Key)) { CloseHandle(kv.Value); watched.Remove(kv.Key); }
    }
    foreach (uint p in want) {
      if (watched.ContainsKey(p)) continue;
      IntPtr h = OpenProcess(SYNCHRONIZE | QUERY_LIMITED, false, p);
      if (h == IntPtr.Zero) {
        int err = Marshal.GetLastWin32Error();
        if (err == 87) Emit("X\t" + p);          // no such process: it's already gone
        else Emit("U\t" + p + "\t" + err);
        continue;
      }
      watched[p] = h;
    }
  }

  static void CheckWatched() {
    if (watched.Count == 0) return;
    foreach (KeyValuePair<uint, IntPtr> kv in new List<KeyValuePair<uint, IntPtr>>(watched)) {
      if (WaitForSingleObject(kv.Value, 0) == 0) {
        CloseHandle(kv.Value);
        watched.Remove(kv.Key);
        Emit("X\t" + kv.Key);
      }
    }
  }

  // Windows only lets the app in front hand over the front. Joining the input of the
  // window in front for a moment is the usual way an app the user asked for gets there.
  static void Focus(string s) {
    long v;
    if (!long.TryParse(s, out v) || v == 0) return;
    IntPtr w = new IntPtr(v);
    IntPtr fg = GetForegroundWindow();
    uint ignore;
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignore);
    uint me = GetCurrentThreadId();
    bool joined = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try {
      if (IsIconic(w)) ShowWindow(w, 9);
      BringWindowToTop(w);
      SetForegroundWindow(w);
    } finally { if (joined) AttachThreadInput(me, fgThread, false); }
    Emit("FOCUSED\t" + (GetForegroundWindow() == w ? "1" : "0"));
  }

  static bool Command(string line) {
    if (line == "EOF") return false;
    string[] p = line.Split('\t');
    switch (p[0]) {
      case "N":
        names.Clear();
        for (int i = 1; i < p.Length; i++) if (p[i].Length > 0) names.Add(p[i]);
        break;
      case "W": SetWatch(p); break;
      case "M":
        if (p.Length >= 4) { int.TryParse(p[1], out mask); int.TryParse(p[2], out fallback); int.TryParse(p[3], out holdMs); }
        break;
      case "REC": rec = p.Length > 1 && p[1] == "1"; lastButtons = -1; break;
      case "FOCUS": if (p.Length > 1) Focus(p[1]); break;
    }
    return true;
  }

  public static void Run(int parentPid, int m, int f, int hold) {
    mask = m; fallback = f; holdMs = hold > 0 ? hold : 1000;
    StartInput();
    IntPtr parent = parentPid > 0 ? OpenProcess(SYNCHRONIZE, false, (uint)parentPid) : IntPtr.Zero;
    Stopwatch clock = Stopwatch.StartNew();
    long heldSince = -1;
    bool fired = false;
    int lastActive = -100;
    uint lastFront = 0;
    for (int t = 1; ; t++) {
      if (parent != IntPtr.Zero && (t % 8) == 0 && WaitForSingleObject(parent, 0) == 0) return;
      string cmd;
      while (cmds.TryDequeue(out cmd)) { if (!Command(cmd)) return; }
      Poll();
      if (Held) {
        if (heldSince < 0) heldSince = clock.ElapsedMilliseconds;
        else if (!fired && clock.ElapsedMilliseconds - heldSince >= holdMs) { Emit("WAKE"); fired = true; }
      } else { heldSince = -1; fired = false; }
      if (Active && (t - lastActive) >= 16) { lastActive = t; Emit("C"); }
      if (rec && Buttons != lastButtons) { lastButtons = Buttons; Emit("B\t" + Buttons); }
      if ((t % 4) == 0) CheckWatched();
      // A new game is looked for every 2 s, every 4 s while one is already playing (then it can
      // only be a second game, and the look should stay out of the way). Measured over a minute:
      // the probe uses about 0.5% of one core with no game and 0.2% during one; 1.13's probe,
      // without any of this, used 0.4 to 0.75%.
      if ((t % (watched.Count > 0 ? 32 : 16)) == 0) Snapshot();
      if ((t % 16) == 0) Front(ref lastFront);
      if ((t % 240) == 0) Emit("H");
      Thread.Sleep(120);
    }
  }
}
"@
try { Add-Type -TypeDefinition $src -ErrorAction Stop }
catch { [Console]::Error.WriteLine('compile: ' + $_.Exception.Message); exit 3 }
[KozoProbe]::Run($ParentPid, $Mask, $Fallback, $HoldMs)
`.trim()

// Anything still asking for it? Each feature can be turned off on its own; watching for
// game starts and ends is always wanted once the library has a game to watch.
function wanted() {
  try {
    if (watchNames.length > 0) return true
    if (require('./controllerWake').isOn()) return true
    const settingsQ = require('../db/queries/settings')
    const away = settingsQ.getSetting('away_pause_sec')
    if (away === null || away === undefined || away === '' || parseInt(away) > 0) return true
    return parseInt(settingsQ.getSetting('idle_pause_min')) > 0
  } catch { return true }
}

// Pure: one probe line into what it means. Exported for scripts/test-parsers.js.
function parseLine(line) {
  const s = String(line || '')
  if (s === 'WAKE' || s === 'C' || s === 'H') return { kind: s }
  const m = /^P([+-])(\d)$/.exec(s)
  if (m) return { kind: 'slot', slot: Number(m[2]), connected: m[1] === '+' }
  const [kind, a, b] = s.split('\t')
  if (kind === 'S') return Number(a) > 0 ? { kind: 'start', pid: Number(a), exe: String(b || '').toLowerCase() } : null
  if (kind === 'X') return Number(a) > 0 ? { kind: 'exit', pid: Number(a) } : null
  if (kind === 'U') return Number(a) > 0 ? { kind: 'unwatchable', pid: Number(a), error: Number(b) || 0 } : null
  if (kind === 'B') return { kind: 'buttons', buttons: Number(a) || 0 }
  if (kind === 'FOCUSED') return { kind: 'focused', ok: a === '1' }
  if (kind === 'F') return { kind: 'front' }
  return null
}

const unwatchableLogged = new Set()
function onLine(line) {
  const p = parseLine(line)
  if (!p) return
  switch (p.kind) {
    case 'WAKE': require('./controllerWake').fire(); break
    case 'C': require('./controllerInput').noteInput(); break
    case 'H': require('./foregroundProbe').onLine(line); break
    case 'front': require('./foregroundProbe').onLine(line); break
    case 'start': require('./processWatcher').onProcessSeen(p.exe, p.pid); break
    case 'exit': require('./processWatcher').onProcessExit(p.pid); break
    case 'unwatchable':
      if (!unwatchableLogged.has(p.pid)) {
        unwatchableLogged.add(p.pid)
        logger.info('desktopProbe: a session process can\'t be watched, the scans will notice its end', { pid: p.pid, error: p.error })
      }
      require('./processWatcher').onProcessUnwatchable?.(p.pid)
      break
    case 'slot': require('./controllerWake').onSlot(p.slot, p.connected); break
    case 'buttons': require('./controllerWake').onButtons(p.buttons); break
    case 'focused': if (!p.ok) logger.info('desktopProbe: Windows kept another window in front'); break
  }
}

function send(line) {
  if (!proc || !proc.stdin || proc.stdin.destroyed) return
  try { proc.stdin.write(line + '\n') } catch {}
}

function sendState() {
  if (watchNames.length) send(['N', ...watchNames].join('\t'))
  send(['W', ...watchPids].join('\t'))
  if (recording) send('REC\t1')
}

function spawnProbe() {
  restartTimer = null
  if (proc || stopped || process.platform !== 'win32' || !wanted()) return
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return
  const { mask, fallback, holdMs } = require('./controllerWake').masks()
  try {
    // Written every start: a probe from an older KoZo must not be run by a newer one.
    scriptPath = scriptPath || path.join(os.tmpdir(), 'kozo-desktop-probe-v2.ps1')
    fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8')
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        String(process.pid), String(mask), String(fallback), String(holdMs)],
      { windowsHide: true })
    proc = child
    const startedAt = Date.now()
    let partial = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const lines = (partial + chunk).split(/\r?\n/)
      partial = lines.pop()
      if (restarts && Date.now() - startedAt > 60000) restarts = 0   // it has run fine for a while
      for (const line of lines) {
        try { onLine(line) } catch (e) { logger.warn('desktopProbe: ' + e.message) }
      }
    })
    // A failed compile or a crash says why on stderr. The first lines are enough.
    let errLines = 0
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (errLines >= 5) return
      for (const l of String(chunk).split(/\r?\n/).filter(Boolean)) {
        if (errLines++ >= 5) break
        logger.warn('desktopProbe stderr: ' + l.slice(0, 400))
      }
    })
    child.stdin.on('error', () => {})
    sendState()
    // Only THIS child may clear the state: an old probe exiting late must not
    // orphan a newer one.
    child.on('exit', (code) => {
      if (proc !== child) return
      proc = null
      require('./foregroundProbe').reset()
      if (stopped) return
      logger.warn('desktopProbe: exited', { code, ranSec: Math.round((Date.now() - startedAt) / 1000) })
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

// Starts it if it should run and doesn't. The combo and the watch lists are sent over
// stdin, so a change never costs a restart (each start compiles the C# again).
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

// The library's exe names (processWatcher). Sent only when they change.
function setWatchNames(names) {
  const next = [...new Set((names || []).map(n => String(n || '').trim().toLowerCase()).filter(n => n.endsWith('.exe') && !n.includes('\t')))].sort()
  if (next.join('\n') === watchNames.join('\n')) return
  watchNames = next
  if (proc) send(['N', ...watchNames].join('\t'))
  else refresh()
}

// The running sessions' processes (processWatcher). Sent only when they change.
function setWatchPids(pids) {
  const next = [...new Set((pids || []).map(Number).filter(n => n > 0))].sort((a, b) => a - b)
  if (next.join(',') === watchPids.join(',')) return
  watchPids = next
  send(['W', ...watchPids].join('\t'))
}

function setMasks({ mask = 0, fallback = 0, holdMs = 1000 } = {}) {
  if (proc) send(`M\t${mask}\t${fallback}\t${holdMs}`)
  else refresh()
}

function setRecording(on) {
  recording = !!on
  if (proc) send(`REC\t${recording ? 1 : 0}`)
  else if (recording) refresh()
}

// Bring a window (Electron's native handle, as a decimal string) to the front.
function focusWindow(hwnd) {
  if (!hwnd || !proc) return false
  send(`FOCUS\t${hwnd}`)
  return true
}

module.exports = {
  start, stop, restart, refresh, isRunning, PS_SCRIPT, parseLine,
  setWatchNames, setWatchPids, setMasks, setRecording, focusWindow,
}
