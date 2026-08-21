const { child } = require('../utils/log')

const log = child('embed')

const DEFAULT_TIMEOUT_MS = 20000
const RETRY_DELAYS_MS = [1000, 3000]

let overrideEmbedder = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const callHuggingFace = async (text) => {
  const response = await fetch(
    "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: [text], // pass an array
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();

  return data[0];
};

const isRetryable = (err) => {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  if (/429|503|502|500|rate/i.test(err.message || '')) return true
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(err.message || '')) return true
  return false
}

const embedText = async (text) => {
  if (overrideEmbedder) return overrideEmbedder(text)

  let lastError
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await callHuggingFace(text)
    } catch (err) {
      lastError = err
      if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) break
      log.warn({ attempt: attempt + 1, err: err.message }, 'embed retry')
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }

  throw lastError
};

// Test seam: replace the network embedder without touching call sites.
const __setEmbedder = (fn) => { overrideEmbedder = fn }

module.exports = { embedText, __setEmbedder };
