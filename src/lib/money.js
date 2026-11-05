// What someone types as a price -> cents. "10", "9.99", "9,99", "$ 1,299" and
// "1.299,50" all work: a separator followed by one or two digits at the end is the
// decimal point, and any other separator only groups thousands. Null = no number.
export function parseMoney(text) {
  const t = String(text ?? '').replace(/[^\d.,]/g, '')
  if (!/\d/.test(t)) return null
  const m = t.match(/^(.*)[.,](\d{1,2})$/)
  const whole = (m ? m[1] : t).replace(/\D/g, '') || '0'
  const cents = Number(whole) * 100 + (m ? Number(m[2].padEnd(2, '0')) : 0)
  return Number.isSafeInteger(cents) ? cents : null
}
