require('dotenv').config()
const connectDB = require('../src/config/db')
const mongoose = require('mongoose')
const Memory = require('../src/models/Memory')
const { handleJsonRpc } = require('../src/services/mcpToolService')

const run = async () => {
  await connectDB()

  const sessionId = `mcp_test_${Date.now()}`
  await Memory.deleteMany({ sessionId })

  console.log('--- test 1: initialize ---')
  const init = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test',
        version: '0.0.1'
      }
    }
  })
  console.log(`protocol: ${init.result?.protocolVersion}, server: ${init.result?.serverInfo?.name}`)

  console.log('\n--- test 2: tools/list ---')
  const list = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  })

  const toolNames = list.result?.tools?.map(t => t.name) || []
  console.log(`tools: ${toolNames.join(', ')}`)

  console.log('\n--- test 3: tools/call memory_save ---')
  const saveCall = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'memory_save',
      arguments: {
        text: 'I prefer Arch Linux over Ubuntu',
        sessionId
      }
    }
  })

  console.log(`content: ${saveCall.result?.content?.[0]?.text}`)

  console.log('\n--- test 3b: memory_save rejects oversized input ---')

  const oversizedText = 'x'.repeat(3000)
  const rejected = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'memory_save',
      arguments: {
        text: oversizedText,
        sessionId
      }
    }
  })

  console.log(`isError: ${rejected.result?.isError}`)
  console.log(`error: ${rejected.result?.content?.[0]?.text?.slice(0, 120)}`)

  console.log('\n--- test 3c: memory_extract handles long text correctly ---')

  const largeText = Array.from({ length: 60 }, (_, i) =>
    `Paragraph ${i + 1}: I enjoy using Arch Linux for software development. ${i % 3 === 0 ? 'I live in Mumbai. ' : ''}${i % 5 === 0 ? 'My project uses PostgreSQL. ' : ''}More padding to make this substantial.`
  ).join('\n\n')

  console.log(`input size: ${largeText.length} chars`)

  const extractCall = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'memory_extract',
      arguments: {
        text: largeText,
        sessionId
      }
    }
  })

  const extractSummary = JSON.parse(extractCall.result?.content?.[0]?.text || '{}')
  console.log(`created: ${extractSummary.created}, updated: ${extractSummary.updated}, skipped: ${extractSummary.skipped}`)

  console.log('\n--- test 3d: verify extracted memories from large input ---')

  const afterLarge = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'memory_list',
      arguments: {
        sessionId
      }
    }
  })

  const largeList = JSON.parse(afterLarge.result?.content?.[0]?.text || '{}')

  console.log(`memory count: ${largeList.count}`)
  largeList.memories?.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.text}`)
  })

  console.log('\n--- test 4: tools/call memory_list ---')
  const listCall = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'memory_list',
      arguments: {
        sessionId
      }
    }
  })

  const listed = JSON.parse(listCall.result?.content?.[0]?.text || '{}')
  console.log(`count: ${listed.count}`)
  listed.memories?.forEach(m => console.log(`  - ${m.text}`))

  console.log('\n--- test 5: tools/call memory_search ---')
  const searchCall = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'memory_search',
      arguments: {
        query: 'what linux distro do I like',
        sessionId
      }
    }
  })

  const searchResult = JSON.parse(searchCall.result?.content?.[0]?.text || '{}')
  console.log(`matches: ${searchResult.count}`)
  searchResult.memories?.forEach(m =>
    console.log(`  - [${m.score?.toFixed(3)}] ${m.text}`)
  )

  console.log('\n--- test 6: tools/call memory_delete ---')

  const targetId = listed.memories?.[0]?.memoryId

  if (targetId) {
    const deleteCall = await handleJsonRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'memory_delete',
        arguments: {
          memoryId: targetId
        }
      }
    })

    console.log(`content: ${deleteCall.result?.content?.[0]?.text}`)

    console.log('\n--- test 6b: verify delete ---')

    const afterDelete = await handleJsonRpc({
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: {
          query: 'Arch Linux',
          sessionId
        }
      }
    })

    const deletedResult = JSON.parse(afterDelete.result?.content?.[0]?.text || '{}')
    console.log(`matches after delete: ${deletedResult.count}`)
  }

  console.log('\n--- test 7: invalid method returns error ---')

  const bad = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'unknown/method'
  })

  console.log(`error code: ${bad.error?.code}, message: ${bad.error?.message}`)

  console.log('\n--- test 8: invalid jsonrpc returns error ---')

  const invalid = await handleJsonRpc({
    jsonrpc: '1.0',
    id: 8,
    method: 'tools/list'
  })

  console.log(`error code: ${invalid.error?.code}, message: ${invalid.error?.message}`)

  console.log('\n--- test 9: session isolation ---')

  const otherSession = `mcp_other_${Date.now()}`

  await handleJsonRpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'memory_save',
      arguments: {
        text: 'I prefer Ubuntu',
        sessionId: otherSession
      }
    }
  })

  const isolation = await handleJsonRpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'memory_search',
      arguments: {
        query: 'Ubuntu',
        sessionId
      }
    }
  })

  const isolationResult = JSON.parse(isolation.result?.content?.[0]?.text || '{}')
  console.log(`matches in original session: ${isolationResult.count}`)

  await Memory.deleteMany({ sessionId })
  await Memory.deleteMany({ sessionId: otherSession })
  await mongoose.disconnect()
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})