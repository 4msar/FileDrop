// peer.js — PeerJS + room-based auto-discovery

import Peer from 'peerjs'

const CHUNK_SIZE = 64 * 1024 // 64KB
const DEFAULT_ROOM = 'filedrop-default-room'

function getRoomId() {
  const hash = window.location.hash.replace('#', '').trim()
  return hash || DEFAULT_ROOM
}

function genId() {
  const adj  = ['swift','calm','bold','keen','wise','fair','cool','warm']
  const noun = ['fox','kite','oak','reef','star','lake','wolf','bird']
  const n = Math.floor(Math.random() * 900 + 100)
  return `${adj[~~(Math.random()*adj.length)]}-${noun[~~(Math.random()*noun.length)]}-${n}`
}

export class FileSharePeer {
  constructor({ onReady, onPeerJoin, onPeerLeave, onFileOffer, onProgress, onError }) {
    this.onReady     = onReady
    this.onPeerJoin  = onPeerJoin
    this.onPeerLeave = onPeerLeave
    this.onFileOffer = onFileOffer
    this.onProgress  = onProgress
    this.onError     = onError

    this.connections     = new Map()
    this.pendingReceive  = null
    this._receiveBuffers = new Map()
    this.isHost          = false
    this.knownPeers      = new Set()
    this.myId            = null
    this._roomHostId     = null

    this._init()
  }

  _init() {
    this._roomHostId = getRoomId()
    this._tryBecomeHost()
  }

  _tryBecomeHost() {
    const hostPeer = new Peer(this._roomHostId)

    hostPeer.on('open', () => {
      this.isHost = true
      this.peer   = hostPeer
      this.myId   = genId()
      this.knownPeers.add(this.myId)
      this.onReady(this.myId)
      this.peer.on('connection', (conn) => this._handleIncoming(conn))
      this.peer.on('error',      (err)  => this.onError(err.message))
    })

    hostPeer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        hostPeer.destroy()
        this._joinAsGuest()
      } else {
        this.onError(err.message)
      }
    })
  }

  _joinAsGuest() {
    const guestPeer = new Peer(genId())

    guestPeer.on('open', (id) => {
      this.isHost = false
      this.peer   = guestPeer
      this.myId   = id
      this.onReady(id)
      this.peer.on('connection', (conn) => this._handleIncoming(conn))
      this.peer.on('error',      (err)  => this.onError(err.message))
      this._connectToHost()
    })

    guestPeer.on('error', (err) => this.onError(err.message))
  }

  _connectToHost() {
    const conn = this.peer.connect(this._roomHostId, { reliable: true })

    conn.on('open', () => {
      conn.send({ type: 'ANNOUNCE', peerId: this.myId })
    })

    conn.on('data', (msg) => {
      if (!msg || !msg.type) return

      if (msg.type === 'PEER_LIST') {
        this.connections.set(msg.hostDisplayId, conn)
        this.onPeerJoin(msg.hostDisplayId)

        msg.peers.forEach((peerId) => {
          if (peerId !== this.myId && !this.connections.has(peerId)) {
            this._connectToPeer(peerId)
          }
        })
      }

      if (msg.type === 'PEER_JOINED') {
        if (msg.peerId !== this.myId && !this.connections.has(msg.peerId)) {
          this._connectToPeer(msg.peerId)
        }
      }

      if (msg.type === 'PEER_LEFT') {
        this._removePeer(msg.peerId)
      }

      this._handleFileMessage(conn, msg)
    })

    conn.on('close', () => {
      this.connections.forEach((c, id) => { if (c === conn) this._removePeer(id) })
      setTimeout(() => this._tryBecomeHost(), 1000)
    })

    conn.on('error', () => {
      this.connections.forEach((c, id) => { if (c === conn) this.connections.delete(id) })
    })
  }

  _connectToPeer(peerId) {
    if (this.connections.has(peerId)) return
    const conn = this.peer.connect(peerId, { reliable: true })

    conn.on('open', () => {
      this.connections.set(peerId, conn)
      this.onPeerJoin(peerId)
    })

    conn.on('data',  (msg) => this._handleFileMessage(conn, msg))
    conn.on('close', ()    => this._removePeer(peerId))
    conn.on('error', ()    => this._removePeer(peerId))
  }

  _handleIncoming(conn) {
    conn.on('data', (msg) => {
      if (!msg || !msg.type) return

      if (msg.type === 'ANNOUNCE') {
        const newDisplayId = msg.peerId

        if (this.isHost) {
          const peerList = [...this.knownPeers].filter(id => id !== newDisplayId)
          conn.send({ type: 'PEER_LIST', hostDisplayId: this.myId, peers: peerList })

          this.connections.forEach((c, id) => {
            if (id !== newDisplayId && c.open) {
              c.send({ type: 'PEER_JOINED', peerId: newDisplayId })
            }
          })

          this.connections.set(newDisplayId, conn)
          this.knownPeers.add(newDisplayId)
          this.onPeerJoin(newDisplayId)

          conn.on('close', () => {
            this.knownPeers.delete(newDisplayId)
            this.connections.forEach((c) => {
              if (c.open) c.send({ type: 'PEER_LEFT', peerId: newDisplayId })
            })
            this._removePeer(newDisplayId)
          })
        }
      }

      this._handleFileMessage(conn, msg)
    })

    conn.on('error', () => {
      this.connections.forEach((c, id) => { if (c === conn) this._removePeer(id) })
    })
  }

  // ── File transfer ──

  sendFile(peerId, file, onProgress) {
    const conn = this.connections.get(peerId)
    if (!conn) throw new Error('Not connected to peer')

    conn.send({ type: 'FILE_OFFER', name: file.name, size: file.size, mime: file.type })

    let offset = 0
    const reader = new FileReader()

    const readNext = () => reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE))

    reader.onload = (e) => {
      conn.send({ type: 'FILE_CHUNK', data: e.target.result })
      offset += e.target.result.byteLength
      const pct = Math.round((offset / file.size) * 100)
      onProgress(pct)
      if (offset < file.size) readNext()
      else { conn.send({ type: 'FILE_DONE' }); onProgress(100) }
    }

    readNext()
  }

  acceptFile() {
    if (!this.pendingReceive) return
    const { peerId } = this.pendingReceive
    this.pendingReceive.resolve()
    // If all chunks already arrived while waiting for accept, download now
    const state = this._receiveBuffers.get(peerId)
    if (state && state.done) this._triggerDownload(peerId)
  }

  declineFile() {
    if (this.pendingReceive) {
      const conn = this.pendingReceive.conn
      if (conn && conn.open) conn.send({ type: 'FILE_DECLINED' })
      this.pendingReceive.reject()
      this.pendingReceive = null
    }
  }

  _triggerDownload(senderId) {
    const state = this._receiveBuffers.get(senderId)
    if (!state) return
    const blob = new Blob(state.chunks, { type: state.meta.mime || 'application/octet-stream' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = state.meta.name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    this._receiveBuffers.delete(senderId)
    this.onProgress(senderId, 100, 'receive')
  }

  _handleFileMessage(conn, msg) {
    if (!msg || !msg.type) return

    let senderId = null
    this.connections.forEach((c, id) => { if (c === conn) senderId = id })
    if (!senderId) return

    if (msg.type === 'FILE_OFFER') {
      this._receiveBuffers.set(senderId, { chunks: [], meta: msg, accepted: false, done: false })
      this.pendingReceive = {
        conn,
        meta: msg,
        peerId: senderId,
        resolve: () => {
          const state = this._receiveBuffers.get(senderId)
          if (state) state.accepted = true
          this.pendingReceive = null
        },
        reject: () => {
          this._receiveBuffers.delete(senderId)
          this.pendingReceive = null
        }
      }
      this.onFileOffer(senderId, msg)
    }

    if (msg.type === 'FILE_CHUNK') {
      const state = this._receiveBuffers.get(senderId)
      if (!state) return
      // Always buffer chunks — even before user accepts
      state.chunks.push(msg.data)
      const received = state.chunks.reduce((a, c) => a + c.byteLength, 0)
      this.onProgress(senderId, Math.round((received / state.meta.size) * 100), 'receive')
    }

    if (msg.type === 'FILE_DONE') {
      const state = this._receiveBuffers.get(senderId)
      if (!state) return
      state.done = true
      // Only download if user already accepted — otherwise acceptFile() will trigger it
      if (state.accepted) this._triggerDownload(senderId)
    }
  }

  _removePeer(peerId) {
    this.connections.delete(peerId)
    this._receiveBuffers.delete(peerId)
    this.onPeerLeave(peerId)
  }
}
