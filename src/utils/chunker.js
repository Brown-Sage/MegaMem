const { child } = require('./log')

const log = child('chunker')

const DEFAULT_MAX_CHARS = 6000
const DEFAULT_OVERLAP_CHARS = 400
const DEFAULT_MAX_CHUNKS = 20

const splitIntoParagraphs = (text) => {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
}

const hardSplit = (text, maxChars, overlapChars) => {
  const chunks = []
  const stride = Math.max(1, maxChars - overlapChars)
  for (let i = 0; i < text.length; i += stride) {
    chunks.push(text.slice(i, i + maxChars))
  }
  return chunks
}

const buildChunksFromParagraphs = ({ paragraphs, maxChars, overlapChars }) => {
  const chunks = []
  let current = ''

  const pushCurrent = () => {
    if (!current) return
    const trimmed = current.trim()
    if (trimmed.length === 0) return
    chunks.push(trimmed)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      pushCurrent()
      chunks.push(...hardSplit(paragraph, maxChars, overlapChars))
      continue
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph

    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }

    pushCurrent()

    if (overlapChars > 0 && chunks.length > 0) {
      const tail = chunks[chunks.length - 1].slice(-overlapChars)
      current = `${tail}\n\n${paragraph}`
    } else {
      current = paragraph
    }
  }

  pushCurrent()

  return chunks.filter(chunk => chunk && chunk.length > 0)
}

const chunkText = (text, options = {}) => {
  if (typeof text !== 'string' || !text.trim()) {
    return []
  }

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS

  if (text.length <= maxChars) {
    return [text.trim()]
  }

  const paragraphs = splitIntoParagraphs(text)
  let chunks = buildChunksFromParagraphs({ paragraphs, maxChars, overlapChars })

  if (chunks.length > maxChunks) {
    // Lossless overflow: merge the tail chunks into larger ones instead of
    // dropping content. Fewer boundaries, zero data loss.
    const originalCount = chunks.length
    const groupSize = Math.ceil(chunks.length / maxChunks)
    const merged = []
    for (let i = 0; i < chunks.length; i += groupSize) {
      merged.push(chunks.slice(i, i + groupSize).join('\n\n'))
    }
    log.warn({ original: originalCount, mergedTo: merged.length }, 'chunk overflow merged')
    chunks = merged
  }

  return chunks
}

module.exports = {
  chunkText,
  dedupeChunks: (chunks) => {
    const seen = new Set()
    const result = []
    for (const chunk of chunks) {
      const key = chunk.replace(/\s+/g, ' ').trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(chunk)
    }
    return result
  },
  DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP_CHARS,
  DEFAULT_MAX_CHUNKS
}
