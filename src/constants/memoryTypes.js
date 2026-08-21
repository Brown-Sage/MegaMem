const MEMORY_TYPES = [
  'preference',
  'fact',
  'decision',
  'task',
  'project_context',
  'constraint',
  'bug',
  'other'
]

const TECHNICAL_MEMORY_TYPES = [
  'project_context',
  'task',
  'constraint',
  'bug',
  'decision'
]

const USER_MEMORY_TYPES = MEMORY_TYPES.filter(
  (type) => !TECHNICAL_MEMORY_TYPES.includes(type)
)

module.exports = {
  MEMORY_TYPES,
  TECHNICAL_MEMORY_TYPES,
  USER_MEMORY_TYPES
}
