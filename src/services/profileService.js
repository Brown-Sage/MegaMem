const Memory = require('../models/Memory')
const Profile = require('../models/Profile')
const { completeChat } = require('./groqService')
const { parseJsonObject } = require('../utils/json')
const { log } = require('../utils/log')

const MIN_MEMORIES_FOR_PROFILE = 3
const REFRESH_AFTER_NEW_MEMORIES = 5

const buildProfileMessages = (memories) => [
  {
    role: 'system',
    content: [
      'You compile a durable user profile from a list of stored memories.',
      'Summarize identity, stable preferences, technical stack, project conventions, and constraints.',
      'Do not invent details that are not supported by the memories.',
      'Return only valid JSON. Do not include markdown.'
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      'Memories:',
      memories.map((m) => `- ${m.text}`).join('\n'),
      '',
      'Return exactly this JSON shape:',
      '{',
      '  "profile": "compact summary of who this user is, their preferences, stack, conventions, and constraints"',
      '}'
    ].join('\n')
  }
]

const compileProfile = async (sessionId, memories) => {
  const content = await completeChat(buildProfileMessages(memories), {
    temperature: 0,
    maxTokens: 1500,
    timeoutMs: 30000
  })

  const parsed = parseJsonObject(content, 'Profile compilation')
  const profile = typeof parsed.profile === 'string' && parsed.profile.trim()
    ? parsed.profile.trim()
    : null

  if (!profile) {
    throw new Error('Profile compilation returned no profile text')
  }

  await Profile.findOneAndUpdate(
    { sessionId },
    {
      sessionId,
      text: profile,
      memoryCount: memories.length,
      updatedAt: new Date()
    },
    { upsert: true, returnDocument: 'after' }
  )

  return profile
}

// Returns a cached profile if fresh enough, otherwise recompiles.
// A profile is stale when enough new memories have accumulated since the
// last compile, or when a forced refresh is requested.
const getProfile = async (sessionId, { force = false } = {}) => {
  const memoryCount = await Memory.countDocuments({ sessionId })
  if (memoryCount < MIN_MEMORIES_FOR_PROFILE) {
    return null
  }

  const cached = await Profile.findOne({ sessionId }).lean()

  if (!force && cached) {
    const newSinceCompile = memoryCount - (cached.memoryCount || 0)
    if (newSinceCompile < REFRESH_AFTER_NEW_MEMORIES) {
      return cached.text
    }
  }

  const memories = await Memory.find({ sessionId })
    .sort({ createdAt: -1 })
    .limit(100)
    .select('text')
    .lean()

  if (memories.length < MIN_MEMORIES_FOR_PROFILE) {
    return null
  }

  log(`[profile] compiling for ${sessionId} (${memories.length} memories)`)
  return compileProfile(sessionId, memories)
}

module.exports = {
  getProfile,
  compileProfile,
  MIN_MEMORIES_FOR_PROFILE,
  REFRESH_AFTER_NEW_MEMORIES
}
