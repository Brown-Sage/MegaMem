const findBalancedObject = (text) => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) var start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== undefined) return text.slice(start, i + 1)
      }
    }
  }
  return null
}

const parseJsonObject = (content, label = 'LLM response') => {
  const cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  const attempts = [cleaned]

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(cleaned.slice(firstBrace, lastBrace + 1))
  }

  const balanced = findBalancedObject(cleaned)
  if (balanced) attempts.push(balanced)

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      // try next strategy
    }
  }

  throw new Error(`${label} returned invalid JSON: ${content.slice(0, 200)}`)
}

module.exports = { parseJsonObject }
