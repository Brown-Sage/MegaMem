const DEFAULT_MAX_CHARS = 6000
const DEFAULT_OVERLAP_CHARS = 400
const DEFAULT_MIN_CHUNK_CHARS = 200
const DEFAULT_MAX_CHUNKS = 20

const splitIntoSentences = (text) => {
  const matches = text.match(/[^.!?\n]+[.!?\n]?/g)
  return matches ? matches.map(s => s.trim()).filter(Boolean) : [text]
}

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

const buildChunksFromParagraphs = ({ paragraphs, maxChars, overlapChars, minChunkChars }) => {
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

  const maxChars = options.maxChars || DEFAULT_MAX_CHARS
  const overlapChars = options.overlapChars || DEFAULT_OVERLAP_CHARS
  const minChunkChars = options.minChunkChars || DEFAULT_MIN_CHUNK_CHARS
  const maxChunks = options.maxChunks || DEFAULT_MAX_CHUNKS

  if (text.length <= maxChars) {
    return [text.trim()]
  }

  const paragraphs = splitIntoParagraphs(text)
  let chunks = buildChunksFromParagraphs({ paragraphs, maxChars, overlapChars, minChunkChars })

  if (chunks.length > maxChunks) {
    const dropped = chunks.length - maxChunks
    console.warn(`[chunker] Truncated chunks from ${chunks.length} to ${maxChunks} (${dropped} chunks dropped)`)
    chunks = chunks.slice(0, maxChunks)
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
