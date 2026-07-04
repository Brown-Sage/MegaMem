const parseJsonObject = (content, label = 'LLM response') => {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`${label} returned invalid JSON: ${content}`)
  }

  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1))
}

module.exports = { parseJsonObject }
