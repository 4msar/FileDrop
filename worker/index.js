// worker/index.js — Cloudflare Worker signaling server
// Groups peers by public IP (same network = same public IP = same room)

export class Room {
  constructor(state) {
    this.state = state
    this.peers = new Map() // peerId → WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url)
    const peerId = url.searchParams.get('peerId')

    if (!peerId) return new Response('peerId required', { status: 400 })

    const upgradeHeader = request.headers.get('Upgrade')
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const [client, server] = Object.values(new WebSocketPair())
    server.accept()

    // Tell everyone else in this room that a new peer joined
    this._broadcast({ type: 'PEER_JOINED', peerId }, peerId)

    // Send new peer the list of everyone already in this room
    const peerList = [...this.peers.keys()]
    server.send(JSON.stringify({ type: 'PEER_LIST', peers: peerList }))

    // Register this peer
    this.peers.set(peerId, server)

    server.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data)
        // Forward signaling messages (offer, answer, ice) to target peer
        if (msg.to && this.peers.has(msg.to)) {
          this.peers.get(msg.to).send(JSON.stringify({ ...msg, from: peerId }))
        }
      } catch (e) {}
    })

    server.addEventListener('close', () => {
      this.peers.delete(peerId)
      this._broadcast({ type: 'PEER_LEFT', peerId }, peerId)
    })

    server.addEventListener('error', () => {
      this.peers.delete(peerId)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  _broadcast(msg, excludePeerId) {
    const data = JSON.stringify(msg)
    this.peers.forEach((ws, id) => {
      if (id !== excludePeerId && ws.readyState === 1) {
        ws.send(data)
      }
    })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Upgrade',
        }
      })
    }

    if (url.pathname === '/signal') {
      // Group by public IP — Cloudflare provides this header automatically
      // Everyone behind the same router shares the same public IP → same room
      const publicIp = request.headers.get('CF-Connecting-IP') || 'default'

      // Allow manual room override via URL hash (for cross-network sharing)
      const roomParam = url.searchParams.get('room')
      const roomId = (roomParam && roomParam !== 'filedrop-default-room')
        ? roomParam
        : publicIp

      console.log(`peer joining room: ${roomId} [${roomParam}] (ip: ${publicIp})`)

      const roomObj = env.ROOMS.get(env.ROOMS.idFromName(roomId))
      return roomObj.fetch(request)
    }

    // Fall through to static assets for any unmatched routes
    return env.ASSETS.fetch(request)
  }
}