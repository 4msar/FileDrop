// frontend/peer.js — native WebRTC, Worker-based signaling

const CHUNK_SIZE = 64 * 1024
const DEFAULT_ROOM = 'filedrop-default-room'
const SIGNAL_URL = import.meta.env.DEV
  ? `ws://${location.hostname}:8787/signal`
  : 'wss://filedrop-signaling.<your-subdomain>.workers.dev/signal'

function getRoomId() {
  return window.location.hash.replace('#', '').trim() || DEFAULT_ROOM
}

function genId() {
  const adj  = ['swift','calm','bold','keen','wise','fair','cool','warm']
  const noun = ['fox','kite','oak','reef','star','lake','wolf','bird']
  const n = Math.floor(Math.random() * 900 + 100)
  return `${adj[~~(Math.random()*adj.length)]}-${noun[~~(Math.random()*noun.length)]}-${n}`
}

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
}

export class FileSharePeer {
  constructor({ onReady, onPeerJoin, onPeerLeave, onFileOffer, onProgress, onError }) {
    this.onReady     = onReady
    this.onPeerJoin  = onPeerJoin
    this.onPeerLeave = onPeerLeave
    this.onFileOffer = onFileOffer
    this.onProgress  = onProgress
    this.onError     = onError

    this.myId            = genId()
    this.ws              = null
    this.peerConns       = new Map() // peerId → RTCPeerConnection
    this.dataChannels    = new Map() // peerId → RTCDataChannel
    this.pendingReceive  = null
    this._receiveBuffers = new Map()

    this._connect()
  }

  _connect() {
    const room = getRoomId()
    const url  = `${SIGNAL_URL}?peerId=${this.myId}&room=${room}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.onReady(this.myId)
    }

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data)

      if (msg.type === 'PEER_LIST') {
        // Connect to all existing peers
        for (const peerId of msg.peers) {
          await this._createOffer(peerId)
        }
      }

      if (msg.type === 'PEER_JOINED') {
        // New peer joined — they will send us an offer, just wait
      }

      if (msg.type === 'PEER_LEFT') {
        this._removePeer(msg.peerId)
      }

      // WebRTC signaling
      if (msg.type === 'offer') {
        await this._handleOffer(msg.from, msg.sdp)
      }

      if (msg.type === 'answer') {
        const pc = this.peerConns.get(msg.from)
        if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      }

      if (msg.type === 'ice') {
        const pc = this.peerConns.get(msg.from)
        if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate)
      }
    }

    this.ws.onclose = () => {
      setTimeout(() => this._connect(), 2000)
    }

    this.ws.onerror = (e) => {
      this.onError('Signaling connection failed')
    }
  }

  _signal(to, msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, to }))
    }
  }

  async _createOffer(peerId) {
    const pc = this._createPC(peerId)
    const dc = pc.createDataChannel('filedrop', { ordered: true })
    this._bindDataChannel(dc, peerId)
    this.dataChannels.set(peerId, dc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this._signal(peerId, { type: 'offer', sdp: offer.sdp })
  }

  async _handleOffer(peerId, sdp) {
    const pc = this._createPC(peerId)

    pc.ondatachannel = (event) => {
      const dc = event.channel
      this.dataChannels.set(peerId, dc)
      this._bindDataChannel(dc, peerId)
    }

    await pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this._signal(peerId, { type: 'answer', sdp: answer.sdp })
  }

  _createPC(peerId) {
    if (this.peerConns.has(peerId)) return this.peerConns.get(peerId)

    const pc = new RTCPeerConnection(RTC_CONFIG)
    this.peerConns.set(peerId, pc)

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._signal(peerId, { type: 'ice', candidate: event.candidate })
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.onPeerJoin(peerId)
      }
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this._removePeer(peerId)
      }
    }

    return pc
  }

  _bindDataChannel(dc, peerId) {
    dc.binaryType = 'arraybuffer'

    dc.onmessage = (event) => {
      this._handleFileMessage(peerId, event.data)
    }
  }

  // ── File transfer ──

  sendFile(peerId, file, onProgress) {
    const dc = this.dataChannels.get(peerId)
    if (!dc || dc.readyState !== 'open') throw new Error('Not connected')

    // Send metadata as JSON string
    dc.send(JSON.stringify({ type: 'FILE_OFFER', name: file.name, size: file.size, mime: file.type }))

    let offset = 0
    const reader = new FileReader()

    const readNext = () => reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE))

    reader.onload = (e) => {
      dc.send(e.target.result)  // raw binary chunk
      offset += e.target.result.byteLength
      const pct = Math.round((offset / file.size) * 100)
      onProgress(pct)
      if (offset < file.size) {
        // Respect buffer to avoid overwhelming the channel
        if (dc.bufferedAmount > 1024 * 1024) {
          setTimeout(readNext, 50)
        } else {
          readNext()
        }
      } else {
        dc.send(JSON.stringify({ type: 'FILE_DONE' }))
        onProgress(100)
      }
    }

    readNext()
  }

  acceptFile() {
    if (!this.pendingReceive) return
    const { peerId } = this.pendingReceive
    this.pendingReceive.resolve()
    const state = this._receiveBuffers.get(peerId)
    if (state && state.done) this._triggerDownload(peerId)
  }

  declineFile() {
    if (this.pendingReceive) {
      const dc = this.dataChannels.get(this.pendingReceive.peerId)
      if (dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'FILE_DECLINED' }))
      }
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

  _handleFileMessage(peerId, data) {
    // JSON messages (control) vs ArrayBuffer (file chunks)
    if (typeof data === 'string') {
      const msg = JSON.parse(data)

      if (msg.type === 'FILE_OFFER') {
        this._receiveBuffers.set(peerId, { chunks: [], meta: msg, accepted: false, done: false })
        this.pendingReceive = {
          peerId,
          meta: msg,
          resolve: () => {
            const state = this._receiveBuffers.get(peerId)
            if (state) state.accepted = true
            this.pendingReceive = null
          },
          reject: () => {
            this._receiveBuffers.delete(peerId)
            this.pendingReceive = null
          }
        }
        this.onFileOffer(peerId, msg)
      }

      if (msg.type === 'FILE_DONE') {
        const state = this._receiveBuffers.get(peerId)
        if (!state) return
        state.done = true
        if (state.accepted) this._triggerDownload(peerId)
      }

    } else {
      // Raw ArrayBuffer = file chunk
      const state = this._receiveBuffers.get(peerId)
      if (!state) return
      state.chunks.push(data)
      const received = state.chunks.reduce((a, c) => a + c.byteLength, 0)
      this.onProgress(peerId, Math.round((received / state.meta.size) * 100), 'receive')
    }
  }

  _removePeer(peerId) {
    const pc = this.peerConns.get(peerId)
    if (pc) pc.close()
    this.peerConns.delete(peerId)
    this.dataChannels.delete(peerId)
    this._receiveBuffers.delete(peerId)
    this.onPeerLeave(peerId)
  }
}