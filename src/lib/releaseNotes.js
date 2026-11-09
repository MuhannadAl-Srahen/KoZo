// Release notes (build/release-notes.md, the GitHub release, latest.yml) as parts the What's new
// window can lay out: the headline, then sections of items. Pure.
//
//   KoZo 1.10.0                        <- skipped
//   One line that sums it up.          <- intro
//   New in 1.10.0                      <- a heading: a line followed by bullets
//   • Title: what it does.             <- item { title, text }
//   • Just text.                       <- item { title: null, text }
//   Fixed in 1.10.0                    <- kind 'fixed' (a quieter list)

const BULLET = /^[•\-*]\s+(.*)$/

function splitItem(t) {
  const m = /^([^:]{2,60}):\s+(.+)$/.exec(t)
  return m && !/https?$/i.test(m[1]) ? { title: m[1].trim(), text: m[2].trim() } : { title: null, text: t.trim() }
}

export function parseNotes(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim())
  let i = 0
  while (i < lines.length && !lines[i]) i++
  if (/^KoZo \d/i.test(lines[i] || '')) i++
  const intro = []
  const sections = []
  let cur = null
  for (; i < lines.length; i++) {
    const l = lines[i].replace(/^#+\s*/, '')
    if (!l) continue
    const b = BULLET.exec(l)
    if (b) {
      if (!cur) { cur = { title: '', kind: 'new', items: [] }; sections.push(cur) }
      cur.items.push(splitItem(b[1]))
      continue
    }
    const next = lines.slice(i + 1).find(x => x)
    if (next && BULLET.test(next)) {
      cur = { title: l, kind: /^(fixed|fixes)\b/i.test(l) ? 'fixed' : 'new', items: [] }
      sections.push(cur)
      continue
    }
    if (!sections.length) intro.push(l)
    else sections.push({ title: '', kind: 'text', items: [{ title: null, text: l }] })
  }
  return { intro: intro.join(' '), sections: sections.filter(s => s.items.length) }
}
