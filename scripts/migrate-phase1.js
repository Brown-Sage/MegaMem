#!/usr/bin/env node
// Phase 1 migration: backfill status:'active' and dedupKey on existing
// memories. Idempotent — safe to re-run. Additive only, never mutates text.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const mongoose = require('mongoose')
const Memory = require('../src/models/Memory')
const { computeDedupKey } = require('../src/utils/dedupKey')

const DRY_RUN = process.argv.includes('--dry-run')

async function main () {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI
  if (!mongoUri) throw new Error('No MONGO_URI found in .env')
  await mongoose.connect(mongoUri)
  console.log('[migrate] connected')

  const query = {
    $or: [
      { status: { $exists: false } },
      { dedupKey: { $exists: false } },
      { dedupKey: '' }
    ]
  }

  const total = await Memory.countDocuments(query)
  console.log(`[migrate] ${total} documents need backfill${DRY_RUN ? ' (dry run)' : ''}`)
  if (total === 0) {
    await mongoose.disconnect()
    return
  }

  const cursor = Memory.find(query).cursor()
  let patched = 0
  let batch = []

  for await (const doc of cursor) {
    const update = {}
    if (!doc.status) update.status = 'active'
    if (!doc.dedupKey) update.dedupKey = computeDedupKey(doc.text)

    if (Object.keys(update).length > 0) {
      batch.push({
        updateOne: { filter: { _id: doc._id }, update: { $set: update } }
      })
    }

    if (batch.length >= 500) {
      if (!DRY_RUN) await Memory.bulkWrite(batch)
      patched += batch.length
      batch = []
      console.log(`[migrate] ${patched}/${total}`)
    }
  }

  if (batch.length > 0) {
    if (!DRY_RUN) await Memory.bulkWrite(batch)
    patched += batch.length
  }

  console.log(`[migrate] done — ${patched} documents patched${DRY_RUN ? ' (dry run, nothing written)' : ''}`)
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message)
  process.exit(1)
})
