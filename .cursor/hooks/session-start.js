const { sessionIdForWorkspace } = require('./common')
const connectDB = require('../../src/config/db')
const mongoose = require('mongoose')
const { retrieveMemory } = require('../../src/services/retrieveService')
const { getProfile } = require('../../src/services/profileService')

// Reads hook JSON from stdin and injects the compiled profile plus recent
// context at session start via `additional_context`.
const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  const sessionId = sessionIdForWorkspace(payload.workspace_roots)

  try {
    await connectDB()

    const [profile, memories] = await Promise.all([
      getProfile(sessionId).catch(() => null),
      retrieveMemory('important preferences and project context', sessionId, 5).catch(() => [])
    ])

    const sections = []

    if (profile) {
      sections.push(`Profile:\n${profile}`)
    }

    if (memories.length > 0) {
      sections.push('Recent memories:\n' + memories.map((m) => `- ${m.text}`).join('\n'))
    }

    const block = sections.length > 0
      ? sections.join('\n\n')
      : '(no memories yet for this workspace)'

    const output = {
      additional_context: `[MegaMem] Memory context for this workspace:\n${block}`
    }
    process.stdout.write(JSON.stringify(output) + '\n')
    await mongoose.disconnect()
  } catch (error) {
    console.error('[megamem session-start]', error.message)
    process.stdout.write('{}\n')
    try { await mongoose.disconnect() } catch { /* ignore */ }
  }
}

main()
