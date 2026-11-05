'use strict'
// Is this exe a game? Its import table says what it loads, read from the file's bytes: nothing
// is started. A game loads graphics, game sound or controller libraries, and a settings tool or
// a map helper usually doesn't. An engine's small starter loads them through the engine, so the
// files beside it count too (UnityPlayer.dll, "<exe>_Data", a Godot .pck).

const fs = require('fs')
const path = require('path')

const GAME_DLL = new RegExp('^(' + [
  'd3d(8|9|10|10_1|10core|11|12)',
  'd3dx\\w*',
  'dxgi',
  'ddraw',
  'opengl32',
  'vulkan-1',
  'dinput8?',
  'xinput\\w*',
  'dsound',
  'xaudio2\\w*',
  'x3daudio\\w*',
  'openal32',
  'soft_oal',
  'sdl[23]?',
  'glfw3?',
  'fmod\\w*',
  'bink\\w*',
  'mss(32|64)',
  'physx\\w*',
  'unityplayer',
  'steam_api(64)?',
].join('|') + ')\\.dll$', 'i')

const MAX_DLLS = 256
const MAX_NAME = 96

// DLLs an exe loads, also the ones it loads late (Unreal does that for its graphics), with
// `read(position, length)` so a 100 MB exe costs a few small reads. Null if it isn't a program.
function parseImports(read) {
  const head = read(0, 8192)
  if (head.length < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null
  const pe = head.readUInt32LE(0x3c)
  if (pe + 24 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null
  const sectionCount = head.readUInt16LE(pe + 6)
  const optional = pe + 24
  if (optional + 2 > head.length) return null
  const is64 = head.readUInt16LE(optional) === 0x20b
  const dirs = optional + (is64 ? 112 : 96)
  const table = optional + head.readUInt16LE(pe + 20)
  if (dirs + 14 * 8 > head.length || table + sectionCount * 40 > head.length) return null

  const sections = []
  for (let i = 0; i < sectionCount; i++) {
    const o = table + i * 40
    sections.push({
      va: head.readUInt32LE(o + 12),
      size: Math.max(head.readUInt32LE(o + 8), head.readUInt32LE(o + 16)),
      raw: head.readUInt32LE(o + 20),
    })
  }
  const toFile = (rva) => {
    const s = sections.find(x => rva >= x.va && rva < x.va + x.size)
    return s ? rva - s.va + s.raw : null
  }
  const nameAt = (rva) => {
    const at = toFile(rva)
    if (at == null) return null
    const b = read(at, MAX_NAME)
    const end = b.indexOf(0)
    return b.toString('latin1', 0, end < 0 ? b.length : end).toLowerCase()
  }

  const dlls = new Set()
  // A normal import entry is 20 bytes with the name at +12, a late one 32 bytes with it at +4.
  const list = (dirRva, size, nameOffset) => {
    const at = dirRva ? toFile(dirRva) : null
    if (at == null) return
    for (let i = 0; i < MAX_DLLS; i++) {
      const b = read(at + i * size, size)
      if (b.length < size || b.every(x => x === 0)) return
      const name = nameAt(b.readUInt32LE(nameOffset))
      if (name) dlls.add(name)
    }
  }
  list(head.readUInt32LE(dirs + 8), 20, 12)
  list(head.readUInt32LE(dirs + 13 * 8), 32, 4)

  return { dlls: [...dlls] }
}

function readImports(file) {
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    return parseImports((pos, len) => {
      const b = Buffer.alloc(len)
      return b.subarray(0, fs.readSync(fd, b, 0, len, pos))
    })
  } catch {
    return null
  } finally {
    if (fd != null) try { fs.closeSync(fd) } catch {}
  }
}

// Pure: does this list of DLLs belong to a game?
function loadsGameParts(dlls) {
  return (dlls || []).some(d => GAME_DLL.test(d))
}

// Pure: an engine's starter, by the files beside it.
function engineBeside(exeName, names) {
  const base = String(exeName || '').replace(/\.exe$/i, '').toLowerCase()
  const have = new Set((names || []).map(n => String(n).toLowerCase()))
  return have.has('unityplayer.dll') || have.has(`${base}_data`) || have.has(`${base}.pck`) ||
    have.has('data.win') || have.has('game.love') || have.has('nw.pak') || have.has('engine')
}

// Does this exe, in its folder, show signs of being a game?
function looksLikeGame(file) {
  const found = readImports(file)
  if (found && loadsGameParts(found.dlls)) return true
  try {
    return engineBeside(path.basename(file), fs.readdirSync(path.dirname(file)))
  } catch {
    return false
  }
}

module.exports = { parseImports, readImports, loadsGameParts, engineBeside, looksLikeGame }
