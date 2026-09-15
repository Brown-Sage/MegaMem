const { sessionLayersForWorkspace, stateDir, claimSessionOnce } = require('./common')
const { buildTopicIndex, writeTopicIndex } = require('./topic-index')
const connectDB = require('../../src/config/db')
const mongoose = require('mongoose')
const { retrieveMemory } = require('../../src/services/retrieveService')
const { layerLabel } = require('../../src/utils/sessionId')
const { currentUserId } = require('../../src/utils/ownership')
const Profile = require('../../src/models/Profile')
const Memory = require('../../src/models/Memory')

// Cache-only profile read. Compiling a profile is an LLM call that takes 30s+
// while Cursor kills this hook at 20s, so compiling here means the briefing is
// lost entirely on the first chat after new memories land. A cached (slightly
// stale) profile is a far better failure mode; refreshes come from the profile
// tool, which runs outside the hook's time budget.
const cachedProfile = async (sessionId) => {
  const doc = await Profile.findOne({ userId: currentUserId(), sessionId }).lean()
  return doc && doc.text ? doc.text : null
}

const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  // Once installed globally, the user-level hook and this repo's project hook
  // both fire for the same conversation. Only the first one injects.
  const claim = claimSessionOnce('session-start', payload)
  if (!claim.claimed) {
    process.stdout.write('{}\n')
    return
  }

  const layers = sessionLayersForWorkspace(payload.workspace_roots)

  try {
    await connectDB()

    // A briefing is not a question. The relevance gate exists to reject
    // questions that no memory answers — and it judged this generic briefing
    // query unanswerable, so it discarded every result and the hook injected
    // nothing at all. Retrieval can also legitimately be empty on a thin store,
    // so fall back to the newest memories: an empty briefing is a silent
    // failure, and this hook's whole job is to hand over context.
    const [profile, workspaceProfile, retrieved] = await Promise.all([
      cachedProfile(layers.userId).catch(() => null),
      cachedProfile(layers.workspaceId).catch(() => null),
      retrieveMemory('important preferences and project context', layers.ids, 5, undefined, { relevanceGate: false }).catch(() => [])
    ])

    const newestMemories = async () => {
      const docs = await Memory.find({
        sessionId: { $in: layers.ids },
        $or: [{ status: 'active' }, { status: { $exists: false } }]
      }).sort({ updatedAt: -1 }).limit(5).lean()
      return docs.map((doc) => ({ text: doc.text, layer: layerLabel(doc.sessionId, layers) }))
    }

    const memories = retrieved.length > 0
      ? retrieved
      : await newestMemories().catch(() => [])

    // R4a: refresh the lexical topic index for future matchers/injectors.
    // Strictly best-effort — never blocks or fails session start.
    try {
      const index = await buildTopicIndex({ Memory, sessionIds: layers.ids })
      await writeTopicIndex({ stateDir: stateDir(), index })
    } catch (indexErr) {
      console.error('[megamem session-start] topic-index:', indexErr.message)
    }

    const sections = []

    if (profile) {
      sections.push(`Profile:\n${profile}`)
    }

    if (workspaceProfile) {
      sections.push(`Workspace conventions:\n${workspaceProfile}`)
    }

    if (memories.length > 0) {
      sections.push('Recent memories:\n' + memories.map((m) => `- [${m.layer}] ${m.text}`).join('\n'))
    }

    if (sections.length === 0) {
      // Nothing to hand over, so let the other hook (project vs user-level)
      // still try rather than burning the session's only claim.
      claim.release()
      process.stdout.write('{}\n')
      await mongoose.disconnect()
      return
    }

    const output = {
      additional_context: `[MegaMem] Memory context for this workspace:\n${sections.join('\n\n')}`
    }
    process.stdout.write(JSON.stringify(output) + '\n')
    await mongoose.disconnect()
  } catch (error) {
    console.error('[megamem session-start]', error.message)
    claim.release()
    process.stdout.write('{}\n')
    try { await mongoose.disconnect() } catch { /* ignore */ }
  }
}

main()
