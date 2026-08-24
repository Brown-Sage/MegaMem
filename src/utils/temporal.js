// Deterministic relative-date resolution — no LLM calls.
// Resolves expressions like "next month", "two weeks ago",
// "the Sunday before 25 May 2023" against a known session date.

const MONTHS = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11
}

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
}

const MONTH_RE = Object.keys(MONTHS).join('|')
const WEEKDAY_RE = Object.keys(WEEKDAYS).join('|')

const toDate = (y, m, d) => {
  const date = new Date(Date.UTC(y, m, d))
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== d ? null : date
}

const startOfDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

const addDays = (date, days) => {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

const addMonths = (date, months) => {
  const next = new Date(date.getTime())
  const day = next.getUTCDate()
  next.setUTCDate(1)
  next.setUTCMonth(next.getUTCMonth() + months)
  const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
  next.setUTCDate(Math.min(day, daysInMonth))
  return next
}

// "7 May 2023", "May 7, 2023", "May 2023", "7 May", "2023-05-07"
const parseAbsoluteDate = (text, fallbackYear = null) => {
  const trimmed = String(text).trim()

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed)
  if (iso) {
    const date = toDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    if (date) return date
  }

  const dMy = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})`, 'i').exec(trimmed)
  if (dMy) {
    const date = toDate(Number(dMy[3]), MONTHS[dMy[2].toLowerCase()], Number(dMy[1]))
    if (date) return date
  }

  const mdY = new RegExp(`(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i').exec(trimmed)
  if (mdY) {
    const date = toDate(Number(mdY[3]), MONTHS[mdY[1].toLowerCase()], Number(mdY[2]))
    if (date) return date
  }

  const dM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?\\b`, 'i').exec(trimmed)
  if (dM) {
    const year = dM[3] ? Number(dM[3]) : fallbackYear
    if (year) {
      const date = toDate(year, MONTHS[dM[2].toLowerCase()], Number(dM[1]))
      if (date) return date
    }
  }

  const mM = new RegExp(`\\b(?<!\\d{1,2}\\s)(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'i').exec(trimmed)
  if (mM) {
    const date = toDate(Number(mM[2]), MONTHS[mM[1].toLowerCase()], 1)
    if (date) return date
  }

  return null
}

// Pulls the session date out of a header like
// "Conversation session (7 May 2023):" — tolerant of format drift.
const parseSessionDate = (text) => {
  if (!text) return null
  const head = String(text).slice(0, 300)
  const paren = /\(([^)]{6,60})\)/.exec(head)
  if (paren) {
    const date = parseAbsoluteDate(paren[1])
    if (date) return date
    const yearOnly = /\b(20\d{2})\b/.exec(paren[1])
    if (yearOnly) return toDate(Number(yearOnly[1]), 0, 1)
  }
  return null
}

const resolveWeekdayRelation = (text, base) => {
  const re = new RegExp(`(${WEEKDAY_RE})\\s+(before|after|past)\\s+((?:\\d{1,2}\\s+)?(?:${MONTH_RE})\\.?[\\s,]*(?:\\d{4})?|(?:${MONTH_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?[\\s,]*(?:\\d{4})?)`, 'gi')

  let match
  while ((match = re.exec(text)) !== null) {
    const anchor = parseAbsoluteDate(match[3], base?.getUTCFullYear())
    if (!anchor) continue
    const target = WEEKDAYS[match[1].toLowerCase()]
    const direction = match[2].toLowerCase() === 'before' ? -1 : 1

    let cursor = anchor
    do {
      cursor = addDays(cursor, direction)
    } while (cursor.getUTCDay() !== target)

    return cursor
  }
  return null
}

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12
}

const NUM = `(\\d+|${Object.keys(NUMBER_WORDS).join('|')})`

const toNumber = (word) => {
  const n = Number(word)
  return Number.isFinite(n) && word !== '' ? n : (NUMBER_WORDS[String(word).toLowerCase()] ?? null)
}

const RELATIVE_PATTERNS = [
  { re: /\byesterday\b|\blast night\b/i, fn: (base) => addDays(base, -1) },
  { re: /\btoday\b|\btonight\b/i, fn: (base) => base },
  { re: /\btomorrow\b/i, fn: (base) => addDays(base, 1) },
  { re: /\blast week\b/i, fn: (base) => addDays(base, -7) },
  { re: /\bnext week\b/i, fn: (base) => addDays(base, 7) },
  { re: /\blast month\b/i, fn: (base) => addMonths(base, -1) },
  { re: /\bnext month\b/i, fn: (base) => addMonths(base, 1) },
  { re: /\blast year\b/i, fn: (base) => addMonths(base, -12) },
  { re: new RegExp(`\\bin ${NUM} days?\\b`, 'i'), fn: (base, m) => addDays(base, toNumber(m[1])) },
  { re: new RegExp(`\\bin ${NUM} weeks?\\b`, 'i'), fn: (base, m) => addDays(base, toNumber(m[1]) * 7) },
  { re: new RegExp(`\\bin ${NUM} months?\\b`, 'i'), fn: (base, m) => addMonths(base, toNumber(m[1])) },
  { re: new RegExp(`\\b${NUM} days? ago\\b`, 'i'), fn: (base, m) => addDays(base, -toNumber(m[1])) },
  { re: new RegExp(`\\b${NUM} weeks? ago\\b`, 'i'), fn: (base, m) => addDays(base, -toNumber(m[1]) * 7) },
  { re: new RegExp(`\\b${NUM} months? ago\\b`, 'i'), fn: (base, m) => addMonths(base, -toNumber(m[1])) },
  { re: new RegExp(`\\b${NUM} years? ago\\b`, 'i'), fn: (base, m) => addMonths(base, -toNumber(m[1]) * 12) }
]

const resolveRelativeExpression = (text, base) => {
  for (const pattern of RELATIVE_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match) return pattern.fn(startOfDay(base), match)
  }
  return null
}

// Resolve an event date for a memory from its own text plus the date of the
// session it came from. Returns a UTC Date or null when nothing resolvable.
const resolveEventDate = (text, sessionDate = null) => {
  if (!text) return null
  const haystack = String(text)

  if (sessionDate) {
    const weekday = resolveWeekdayRelation(haystack, sessionDate)
    if (weekday) return weekday

    const relative = resolveRelativeExpression(haystack, sessionDate)
    if (relative) return relative
  }

  const absolute = parseAbsoluteDate(haystack)
  if (absolute) return absolute

  const yearOnly = /\b(19\d{2}|20\d{2})\b/.exec(haystack)
  if (yearOnly) return toDate(Number(yearOnly[1]), 0, 1)

  return null
}

// Does the text use a relative time expression ("next month", "two weeks ago",
// "last Friday") whose meaning depends on when it was said?
const hasRelativeTimePhrase = (text) => {
  if (!text) return false
  for (const pattern of RELATIVE_PATTERNS) {
    if (pattern.re.test(text)) return true
  }
  if (new RegExp(`\\b(${WEEKDAY_RE})\\b`, 'i').test(text)) return true
  return false
}

// Downstream consumers (relevance gate, chat prompts, eval judges) only see
// memory TEXT, never metadata fields like eventAt. When a memory says "next
// month" and we resolved that to an absolute date, append the date so the
// text is self-contained: "planning a camping trip next month (June 2023)".
// Skips texts that already carry an absolute date and ones with nothing
// relative to clarify.
const bakeResolvedDate = (text, eventAt) => {
  if (!text || !eventAt) return text

  let baked = String(text).trim()
  if (!hasRelativeTimePhrase(baked)) return baked
  // Already contains an absolute date — nothing to clarify.
  if (parseAbsoluteDate(baked)) return baked

  const d = new Date(eventAt)
  if (Number.isNaN(d.getTime())) return baked

  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']
  const label = `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`

  baked = `${baked} (${label})`

  return baked
}

module.exports = {
  parseSessionDate,
  parseAbsoluteDate,
  resolveEventDate,
  bakeResolvedDate,
  hasRelativeTimePhrase,
  addDays,
  addMonths
}
