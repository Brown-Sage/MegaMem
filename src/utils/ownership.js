// Server-side identity for memory ownership. Never accept userId from
// clients — MCP args and HTTP bodies have no userId field by design; every
// read/write derives the owner here so one caller can never touch another
// caller's memories even if they know the sessionId.
const DEFAULT_USER_ID = 'default-user'

const currentUserId = () => process.env.MEGAMEM_USER_ID || DEFAULT_USER_ID

module.exports = {
  DEFAULT_USER_ID,
  currentUserId
}
