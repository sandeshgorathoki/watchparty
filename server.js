const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

// Minimal signaling server for two-person rooms
io.on('connection', (socket) => {
  console.log('socket connected', socket.id)

  socket.on('join-room', (roomId) => {
    socket.join(roomId)
    socket.data.room = roomId
    console.log(`${socket.id} joined ${roomId}`)
    // notify others in the room that a peer joined
    socket.to(roomId).emit('peer-joined')
  })

  socket.on('signal', (payload) => {
    const roomId = socket.data.room
    if (!roomId) return
    // relay the signal to other peers in the room
    socket.to(roomId).emit('signal', payload)
  })

  socket.on('watch-state', (payload) => {
    const roomId = socket.data.room
    if (!roomId) return
    socket.to(roomId).emit('watch-state', payload)
  })

  socket.on('disconnect', () => {
    const roomId = socket.data.room
    if (roomId) socket.to(roomId).emit('peer-left')
    console.log('socket disconnected', socket.id)
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => console.log(`Signaling server listening on ${PORT}`))
