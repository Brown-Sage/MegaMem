require('dotenv').config()
const { embedText } = require('../src/services/embedService')

const run = async () => {
  const vector = await embedText('I love building AI projects')
  console.log('Vector length:', vector.length)
  console.log('First 5 values:', vector.slice(0, 5))
}

run()