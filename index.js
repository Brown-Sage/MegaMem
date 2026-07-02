require('dotenv').config()
const express = require('express')
const connectDB = require('./src/config/db')

const app = express()
app.use(express.json())

connectDB()

app.get('/', (req, res) => {
  res.json({ message: 'Megamem API running' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))