const { test } = require('node:test')
const assert = require('node:assert')
const {
  parseSessionDate,
  parseAbsoluteDate,
  resolveEventDate,
  bakeResolvedDate,
  hasRelativeTimePhrase,
  addDays,
  addMonths
} = require('../../src/utils/temporal')

const utc = (date) => date.toISOString().slice(0, 10)

// --- parseAbsoluteDate ---
test('absolute: D Month YYYY', () => {
  const d = parseAbsoluteDate('7 May 2023')
  assert.equal(utc(d), '2023-05-07')
})

test('absolute: Month D, YYYY', () => {
  const d = parseAbsoluteDate('May 7th, 2023')
  assert.equal(utc(d), '2023-05-07')
})

test('absolute: ISO format', () => {
  const d = parseAbsoluteDate('2023-05-07')
  assert.equal(utc(d), '2023-05-07')
})

test('absolute: Month YYYY defaults to day 1', () => {
  const d = parseAbsoluteDate('June 2023')
  assert.equal(utc(d), '2023-06-01')
})

test('absolute: D Month uses fallbackYear', () => {
  const d = parseAbsoluteDate('7 May', 2023)
  assert.equal(utc(d), '2023-05-07')
})

test('absolute: returns null on no date', () => {
  assert.equal(parseAbsoluteDate('likes pottery'), null)
})

test('absolute: invalid calendar dates rejected', () => {
  assert.equal(parseAbsoluteDate('31 February 2023'), null)
})

// --- parseSessionDate ---
test('session header date parsed', () => {
  const text = 'Conversation session (7 May 2023):\nCaroline: hi'
  assert.equal(utc(parseSessionDate(text)), '2023-05-07')
})

test('session header without date returns null', () => {
  assert.equal(parseSessionDate('Caroline: hi\nDavid: hello'), null)
})

test('session header with year only resolves to Jan 1', () => {
  const d = parseSessionDate('Conversation session (spring 2022):\nA: hi')
  assert.equal(utc(d), '2022-01-01')
})

// --- resolveEventDate relative expressions ---
const base = new Date(Date.UTC(2023, 4, 10)) // 10 May 2023

test('relative: next month from session date', () => {
  const d = resolveEventDate('planning to go camping next month', base)
  assert.equal(utc(d), '2023-06-10')
})

test('relative: yesterday', () => {
  const d = resolveEventDate('went to the support group yesterday', base)
  assert.equal(utc(d), '2023-05-09')
})

test('relative: two weeks ago', () => {
  const d = resolveEventDate('finished the painting two weeks ago', base)
  assert.equal(utc(d), '2023-04-26')
})

test('relative: in three weeks', () => {
  const d = resolveEventDate('conference is in 3 weeks', base)
  assert.equal(utc(d), '2023-05-31')
})

test('relative weekday: the Sunday before a date', () => {
  const d = resolveEventDate('ran the charity race the sunday before 25 May 2023', base)
  assert.equal(utc(d), '2023-05-21')
})

test('relative weekday: the friday before a D-Month phrase (year from context)', () => {
  const d = resolveEventDate('attended the adoption meeting the friday before 15 July', base)
  assert.equal(utc(d), '2023-07-14')
})

test('absolute in fact wins when present', () => {
  const d = resolveEventDate('signed up for pottery on 2 July 2023', base)
  assert.equal(utc(d), '2023-07-02')
})

test('bare year resolves to Jan 1 of that year', () => {
  const d = resolveEventDate('read Nothing is Impossible in 2022', base)
  assert.equal(utc(d), '2022-01-01')
})

test('no resolvable date returns null', () => {
  assert.equal(resolveEventDate('uses pottery for self-expression', base), null)
  assert.equal(resolveEventDate('went yesterday'), null)
})

// --- arithmetic helpers ---
test('addDays crosses month boundary', () => {
  assert.equal(utc(addDays(new Date(Date.UTC(2023, 4, 31)), 1)), '2023-06-01')
})

test('addMonths clamps day-of-month', () => {
  assert.equal(utc(addMonths(new Date(Date.UTC(2023, 0, 31)), 1)), '2023-02-28')
})

// --- hasRelativeTimePhrase ---
test('hasRelativeTimePhrase: detects common relative expressions', () => {
  assert.equal(hasRelativeTimePhrase('planning a camping trip next month'), true)
  assert.equal(hasRelativeTimePhrase('went hiking last Friday'), true)
  assert.equal(hasRelativeTimePhrase('started a new job two weeks ago'), true)
})

test('hasRelativeTimePhrase: false for absolute dates or no dates', () => {
  assert.equal(hasRelativeTimePhrase('adopted Pixie on 2 April 2023'), false)
  assert.equal(hasRelativeTimePhrase('prefers tea over coffee'), false)
})

// --- bakeResolvedDate ---
test('bakeResolvedDate appends month-year label for relative phrases', () => {
  const baked = bakeResolvedDate('Melanie is going camping next month', new Date(Date.UTC(2023, 5, 15)))
  assert.equal(baked, 'Melanie is going camping next month (June 2023)')
})

test('bakeResolvedDate leaves absolute-date texts untouched', () => {
  const text = 'Audrey adopted a puppy named Pixie on 2 April 2023.'
  assert.equal(bakeResolvedDate(text, new Date(Date.UTC(2023, 3, 2))), text)
})

test('bakeResolvedDate leaves texts without relative phrases untouched', () => {
  const text = 'Caroline is a transgender woman'
  assert.equal(bakeResolvedDate(text, new Date(Date.UTC(2023, 6, 1))), text)
})

test('bakeResolvedDate handles null/invalid input', () => {
  assert.equal(bakeResolvedDate(null, new Date()), null)
  assert.equal(bakeResolvedDate('next month trip', null), 'next month trip')
})
