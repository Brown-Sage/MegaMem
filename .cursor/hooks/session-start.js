const { sessionLayersForWorkspace } = require('./common')
const connectDB = require('../../src/config/db')
const mongoose = require('mongoose')
const { retrieveMemory } = require('../../src/services/retrieveService')
const { getProfile } = require('../../src/services/profileService')

const main = async () => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk

  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { /* ignore */ }

  const layers = sessionLayersForWorkspace(payload.workspace_roots)

  try {
    await connectDB()

    const [profile, workspaceProfile, memories] = await Promise.all([
      getProfile(layers.userId).catch(() => null),
      getProfile(layers.workspaceId).catch(() => null),
      retrieveMemory('important preferences and project context', layers.ids, 5).catch(() => [])
    ])

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
    process.stdout.write('{}\n')
    try { await mongoose.disconnect() } catch { /* ignore */ }
  }
}

main()
