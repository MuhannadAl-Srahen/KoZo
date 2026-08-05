// Parser for Valve's binary KeyValues format — the encoding Steam uses for the
// local stats files in <Steam>\appcache\stats\:
//   • UserGameStatsSchema_<appid>.bin        (stat/achievement definitions)
//   • UserGameStats_<accountid>_<appid>.bin  (the player's current stat values)
//
// A node is a sequence of typed entries, each: [type u8][name cstring][value],
// terminated by 0x08 (or 0x0B in v2 files). Nested objects recurse.
// Reference: SteamKit's KeyValue binary serialization.
//
// Everything here is defensive: a malformed/unknown byte aborts the parse and
// the caller falls back to the Steam Web API. Never throws.

const TYPE_NONE      = 0x00  // nested object
const TYPE_STRING    = 0x01
const TYPE_INT32     = 0x02
const TYPE_FLOAT32   = 0x03
const TYPE_PTR       = 0x04
const TYPE_WSTRING   = 0x05
const TYPE_COLOR     = 0x06
const TYPE_UINT64    = 0x07
const TYPE_END       = 0x08
const TYPE_INT64     = 0x0A
const TYPE_END_ALT   = 0x0B

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0 }
  u8()  { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v }
  f32() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v }
  i64() { const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v }
  u64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v }
  cstring() {
    const end = this.buf.indexOf(0, this.pos)
    if (end === -1) throw new Error('unterminated string')
    const s = this.buf.toString('utf8', this.pos, end)
    this.pos = end + 1
    return s
  }
}

function parseNode(r, depth) {
  if (depth > 32) throw new Error('kv depth exceeded')
  const obj = {}
  while (true) {
    const type = r.u8()
    if (type === TYPE_END || type === TYPE_END_ALT) return obj
    const name = r.cstring()
    switch (type) {
      case TYPE_NONE:    obj[name] = parseNode(r, depth + 1); break
      case TYPE_STRING:  obj[name] = r.cstring(); break
      case TYPE_WSTRING: obj[name] = r.cstring(); break   // rare; treated as utf8
      case TYPE_INT32:
      case TYPE_PTR:
      case TYPE_COLOR:   obj[name] = r.i32(); break
      case TYPE_FLOAT32: obj[name] = r.f32(); break
      case TYPE_UINT64:  obj[name] = r.u64(); break
      case TYPE_INT64:   obj[name] = r.i64(); break
      default: throw new Error(`unknown kv type 0x${type.toString(16)}`)
    }
  }
}

/** Parse a binary KeyValues buffer into a plain object, or null on failure. */
function parseBinaryKV(buf) {
  if (!buf || buf.length < 2) return null
  try {
    const r = new Reader(buf)
    const root = parseNode(r, 0)
    return root && Object.keys(root).length ? root : null
  } catch {
    return null
  }
}

// Case-insensitive child lookup — key casing varies between Steam file versions.
function child(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  if (obj[key] !== undefined) return obj[key]
  const kl = key.toLowerCase()
  for (const k of Object.keys(obj)) if (k.toLowerCase() === kl) return obj[k]
  return undefined
}

// An achievement-carrying stat. Steam writes this field either as the numeric
// enum (4) or — in every current schema file — as the literal string
// "ACHIEVEMENTS". Only the numeric form used to be accepted, so `Number(type)`
// was NaN for real files, no bits were ever extracted, and the whole local
// stats path silently fell back to the Web API on every game. Accept both.
function isAchievementStat(type) {
  if (type == null) return false
  if (Number(type) === 4) return true
  return String(type).trim().toUpperCase() === 'ACHIEVEMENTS'
}

// Root is keyed by appid (sometimes wrapped once more) — find the "stats" node.
// Returned separately from the bit extraction so callers can tell "this schema
// is unreadable" apart from "this schema is fine and the game has no
// achievements" — two very different answers.
function findSchemaStatsNode(schemaRoot) {
  const queue = [schemaRoot]
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object') continue
    const s = child(node, 'stats')
    if (s && typeof s === 'object') return s
    for (const v of Object.values(node)) if (v && typeof v === 'object') queue.push(v)
  }
  return null
}

/**
 * Extract the achievement bit layout from a parsed UserGameStatsSchema_<appid>
 * object: [{ statId, bit, apiName }]. Achievement bits live in ACHIEVEMENTS-type
 * stats, under a "bits" subtree keyed by bit index.
 */
function extractAchievementBits(schemaRoot) {
  const out = []
  if (!schemaRoot) return out
  const statsNode = findSchemaStatsNode(schemaRoot)
  if (!statsNode) return out

  for (const [statKey, stat] of Object.entries(statsNode)) {
    if (!stat || typeof stat !== 'object') continue
    if (!isAchievementStat(child(stat, 'type'))) continue
    const bits = child(stat, 'bits')
    if (!bits || typeof bits !== 'object') continue
    for (const [bitKey, bitNode] of Object.entries(bits)) {
      if (!bitNode || typeof bitNode !== 'object') continue
      const apiName = child(bitNode, 'name')
      if (!apiName || typeof apiName !== 'string') continue
      const bit = Number(child(bitNode, 'bit') ?? bitKey)
      if (!Number.isInteger(bit) || bit < 0 || bit > 31) continue
      out.push({ statId: String(statKey), bit, apiName })
    }
  }
  return out
}

// The player-values node. Real UserGameStats files put it under "cache";
// "stats" is accepted too for older/other layouts. Looking only for "stats"
// was the second half of why local parsing never produced anything.
const VALUE_NODE_KEYS = ['cache', 'stats']

function findValueNode(statsRoot) {
  const queue = [statsRoot]
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object') continue
    for (const key of VALUE_NODE_KEYS) {
      const s = child(node, key)
      if (s && typeof s === 'object') return s
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') queue.push(v)
  }
  return null
}

/**
 * Extract the player's stat values from a parsed UserGameStats_<acct>_<appid>
 * object: { statId → int32 bitfield }.
 */
function extractStatValues(statsRoot) {
  const out = {}
  if (!statsRoot) return out
  const s = findValueNode(statsRoot)
  if (!s) return out
  for (const [k, v] of Object.entries(s)) {
    if (!/^\d+$/.test(k)) continue          // skips crc / PendingChanges
    if (typeof v === 'number') out[k] = v
    else if (v && typeof v === 'object') {
      // Real layout: { "3": { data: <bitfield>, AchievementTimes: {...} } }
      const data = child(v, 'data')
      if (typeof data === 'number') out[k] = data
    }
  }
  return out
}

/**
 * Per-stat unlock timestamps: { statId → { bitIndex → unixSeconds } }.
 * Steam records exactly when each achievement popped, right here in the local
 * file — so a local read can carry the real unlock date instead of stamping
 * "now" and waiting for the Web API to correct it later.
 */
function extractAchievementTimes(statsRoot) {
  const out = {}
  if (!statsRoot) return out
  const s = findValueNode(statsRoot)
  if (!s) return out
  for (const [k, v] of Object.entries(s)) {
    if (!/^\d+$/.test(k) || !v || typeof v !== 'object') continue
    const times = child(v, 'AchievementTimes')
    if (!times || typeof times !== 'object') continue
    const perBit = {}
    for (const [bitKey, t] of Object.entries(times)) {
      const n = Number(t)
      if (/^\d+$/.test(bitKey) && Number.isFinite(n) && n > 0) perBit[bitKey] = n
    }
    if (Object.keys(perBit).length) out[k] = perBit
  }
  return out
}

/**
 * Combine schema bits + player stat values into the unlocked achievements, as
 * Map<apiName, unlockUnixSeconds|0>. Returns null if the schema yielded no bits
 * (signals the caller to use the Web API fallback instead).
 */
function unlockedWithTimes(schemaRoot, statsRoot) {
  const bits = extractAchievementBits(schemaRoot)
  if (!bits.length) {
    // No bits, but the schema itself read fine → the game genuinely publishes
    // no achievements (a demo, an unreleased title). That's a complete answer:
    // an empty result, not a parse failure. Returning null here instead made
    // the caller fall back to a Web API burst for a game with nothing to sync.
    return findSchemaStatsNode(schemaRoot) ? new Map() : null
  }
  const values = extractStatValues(statsRoot)
  const times  = extractAchievementTimes(statsRoot)
  const unlocked = new Map()
  for (const { statId, bit, apiName } of bits) {
    const v = values[statId]
    // >>> coerces to uint32 first, so a negative int32 bitfield still reads right.
    if (typeof v !== 'number' || ((v >>> bit) & 1) !== 1) continue
    unlocked.set(apiName, times[statId]?.[String(bit)] || 0)
  }
  return unlocked
}

/** Set-only view of unlockedWithTimes, for callers that don't need timestamps. */
function unlockedApiNames(schemaRoot, statsRoot) {
  const m = unlockedWithTimes(schemaRoot, statsRoot)
  return m === null ? null : new Set(m.keys())
}

module.exports = {
  parseBinaryKV, extractAchievementBits, extractStatValues,
  extractAchievementTimes, unlockedWithTimes, unlockedApiNames,
}
