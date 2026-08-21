const path = require('path')
const crypto = require('crypto')
const { TECHNICAL_MEMORY_TYPES } = require('../constants/memoryTypes')

const DEFAULT_SESSION_ID = 'default-user'

const uniqueIds = (...ids) => [...new Set(ids.filter(Boolean))]

const userSessionId = () => process.env.MEGAMEM_USER_ID || DEFAULT_SESSION_ID

const workspaceSessionId = (cwd = process.cwd()) => {
  if (process.env.MEGAMEM_WORKSPACE_ID) return process.env.MEGAMEM_WORKSPACE_ID

  const base = path.basename(cwd)
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

const resolveSessionIds = (explicit, cwd) => {
  if (explicit) {
    return {
      userId: explicit,
      workspaceId: explicit,
      explicit,
      ids: [explicit]
    }
  }

  const userId = userSessionId()
  const workspaceId = workspaceSessionId(cwd)

  return {
    userId,
    workspaceId,
    explicit: null,
    ids: uniqueIds(userId, workspaceId)
  }
}

const resolveSessionId = (explicit, cwd) => resolveSessionIds(explicit, cwd).ids[0]

const targetSessionId = (layers, type = 'other', scope) => {
  if (layers.explicit) return layers.explicit
  if (scope === 'user') return layers.userId
  if (scope === 'workspace') return layers.workspaceId
  return TECHNICAL_MEMORY_TYPES.includes(type) ? layers.workspaceId : layers.userId
}

const layerLabel = (sessionId, layers) => {
  if (!layers || layers.explicit) return 'explicit'
  if (sessionId === layers.userId && sessionId !== layers.workspaceId) return 'user'
  if (sessionId === layers.workspaceId && sessionId !== layers.userId) return 'workspace'
  if (sessionId === layers.userId) return 'user'
  return 'explicit'
}

module.exports = {
  DEFAULT_SESSION_ID,
  userSessionId,
  workspaceSessionId,
  resolveSessionIds,
  resolveSessionId,
  targetSessionId,
  layerLabel
}
