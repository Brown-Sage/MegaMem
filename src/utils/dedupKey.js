// Normalized key for exact-duplicate detection: case, punctuation and
// whitespace insensitive so "Uses  Vim!" and "uses vim" collapse to one key.
const computeDedupKey = (text) => String(text)
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()

module.exports = { computeDedupKey }
