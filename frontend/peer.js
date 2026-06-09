// frontend/peer.js — native WebRTC, trickle ICE with candidate queuing

const CHUNK_SIZE = 64 * 1024;
const DEFAULT_ROOM = "filedrop-default-room";

const isLocal = window.location.href.startsWith("http://");

const SIGNAL_URL = isLocal
  ? `ws://${location.hostname}:8787/signal`
  : `wss://${location.hostname}/signal`;

function getRoomId() {
  return window.location.hash.replace("#", "").trim() || DEFAULT_ROOM;
}

function genId() {
  const adj = ["swift", "calm", "bold", "keen", "wise", "fair", "cool", "warm"];
  const noun = ["fox", "kite", "oak", "reef", "star", "lake", "wolf", "bird"];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${adj[~~(Math.random() * adj.length)]}-${noun[~~(Math.random() * noun.length)]}-${n}`;
}

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class FileSharePeer {
  constructor({
    onReady,
    onPeerJoin,
    onPeerLeave,
    onFileOffer,
    onProgress,
    onError,
  }) {
    this.onReady = onReady;
    this.onPeerJoin = onPeerJoin;
    this.onPeerLeave = onPeerLeave;
    this.onFileOffer = onFileOffer;
    this.onProgress = onProgress;
    this.onError = onError;

    // Check sessionStorage for per-tab persisted custom ID
    const persistedId = sessionStorage.getItem("filedrop-my-id");
    this.myId = persistedId || genId();
    this.ws = null;
    this.peerConns = new Map(); // peerId → { pc, iceCandidateQueue, remoteDescSet }
    this.dataChannels = new Map();
    this.pendingReceive = null;
    this._receiveBuffers = new Map();
    this._disconnectTimers = new Map();
    this._reconnectingPeers = new Set();
    this._heartbeatInterval = null;

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this._onPageVisible();
      });
    }

    this._connect();
  }

  _connect() {
    const room = getRoomId();
    const url = `${SIGNAL_URL}?peerId=${this.myId}&room=${room}`;
    console.log("[signal] connecting to", url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[signal] connected");
      this._startHeartbeat();
      this.onReady(this.myId);
    };

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      console.log(
        "[signal] received:",
        msg.type,
        msg.from || "",
        msg.peers || "",
      );

      if (msg.type === "PEER_LIST") {
        for (const peerId of msg.peers) {
          console.log("[rtc] creating offer for", peerId);
          await this._createOffer(peerId);
        }
      }

      if (msg.type === "PEER_JOINED") {
        console.log(
          "[signal] peer joined, waiting for their offer:",
          msg.peerId,
        );
      }

      if (msg.type === "PEER_LEFT") {
        this._removePeer(msg.peerId);
      }

      if (msg.type === "offer") {
        console.log("[rtc] got offer from", msg.from);
        await this._handleOffer(msg.from, msg.sdp);
      }

      if (msg.type === "answer") {
        console.log("[rtc] got answer from", msg.from);
        await this._handleAnswer(msg.from, msg.sdp);
      }

      if (msg.type === "ice") {
        console.log(
          "[rtc] got ICE from",
          msg.from,
          msg.candidate?.candidate?.split(" ")[7],
        );
        await this._handleIce(msg.from, msg.candidate);
      }
    };

    this.ws.onclose = (e) => {
      console.log("[signal] closed", e.code, e.reason);
      this._stopHeartbeat();
      setTimeout(() => this._connect(), 2000);
    };

    this.ws.onerror = () => {
      this.onError("Signaling connection failed");
    };
  }

  _signal(to, msg) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...msg, to }));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  _onPageVisible() {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this._connect();
      return;
    }

    for (const [peerId, entry] of this.peerConns) {
      const state = entry.pc.connectionState;
      const dc = this.dataChannels.get(peerId);
      const dcOpen = dc?.readyState === "open";

      if (
        state === "disconnected" ||
        state === "failed" ||
        (state === "connected" && !dcOpen)
      ) {
        this._reconnectPeer(peerId);
      }
    }
  }

  _clearDisconnectTimer(peerId) {
    const timer = this._disconnectTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this._disconnectTimers.delete(peerId);
    }
  }

  _schedulePeerRemoval(peerId, delay) {
    this._clearDisconnectTimer(peerId);
    const timer = setTimeout(() => {
      const entry = this.peerConns.get(peerId);
      if (!entry) return;
      const state = entry.pc.connectionState;
      if (
        state === "disconnected" ||
        state === "failed" ||
        state === "closed"
      ) {
        this._removePeer(peerId);
      }
    }, delay);
    this._disconnectTimers.set(peerId, timer);
  }

  async _reconnectPeer(peerId) {
    if (this._reconnectingPeers.has(peerId)) return;
    this._reconnectingPeers.add(peerId);

    try {
      console.log("[rtc] reconnecting to", peerId);
      const entry = this.peerConns.get(peerId);
      if (entry) {
        entry.pc.close();
        this.peerConns.delete(peerId);
        this.dataChannels.delete(peerId);
      }
      await this._createOffer(peerId);
    } finally {
      this._reconnectingPeers.delete(peerId);
    }
  }

  // ── Create a new RTCPeerConnection with queuing support ──
  _createPC(peerId) {
    if (this.peerConns.has(peerId)) return this.peerConns.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { pc, iceCandidateQueue: [], remoteDescSet: false };
    this.peerConns.set(peerId, entry);

    // Send ICE candidates as they arrive (trickle ICE)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(
          "[rtc] sending ICE to",
          peerId,
          event.candidate.candidate.split(" ")[7],
        );
        this._signal(peerId, { type: "ice", candidate: event.candidate });
      } else {
        console.log("[rtc] ICE gathering complete for", peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(
        "[rtc] connection state with",
        peerId,
        ":",
        pc.connectionState,
      );
      if (pc.connectionState === "connected") {
        this._clearDisconnectTimer(peerId);
        this.onPeerJoin(peerId);
      }
      if (pc.connectionState === "failed") {
        console.log("[rtc] failed with", peerId);
        // Brief delay — mobile file picker can cause transient failures
        this._schedulePeerRemoval(peerId, 5000);
      }
      if (pc.connectionState === "disconnected") {
        // Don't remove immediately — page backgrounding (file picker) causes this
        this._schedulePeerRemoval(peerId, 30000);
      }
      if (pc.connectionState === "closed") {
        this._removePeer(peerId);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log("[rtc] signaling state with", peerId, ":", pc.signalingState);
    };

    pc.onicegatheringstatechange = () => {
      console.log("[rtc] ICE gathering:", pc.iceGatheringState);
    };

    return entry;
  }

  async _createOffer(peerId) {
    const existing = this.peerConns.get(peerId);
    if (existing) {
      const state = existing.pc.connectionState;
      const dc = this.dataChannels.get(peerId);
      if (state === "connected" && dc?.readyState === "open") return;
      existing.pc.close();
      this.peerConns.delete(peerId);
      this.dataChannels.delete(peerId);
    }

    const { pc } = this._createPC(peerId);

    const dc = pc.createDataChannel("filedrop", { ordered: true });
    this._bindDataChannel(dc, peerId);
    this.dataChannels.set(peerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log("[rtc] sending offer to", peerId);
    this._signal(peerId, { type: "offer", sdp: pc.localDescription.sdp });
  }

  async _handleOffer(peerId, sdp) {
    const entry = this._createPC(peerId);
    const { pc } = entry;

    pc.ondatachannel = (event) => {
      console.log("[rtc] got data channel from", peerId);
      const dc = event.channel;
      this.dataChannels.set(peerId, dc);
      this._bindDataChannel(dc, peerId);
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    entry.remoteDescSet = true;

    // Flush any queued ICE candidates that arrived before remote desc
    console.log(
      "[rtc] flushing",
      entry.iceCandidateQueue.length,
      "queued ICE candidates",
    );
    for (const candidate of entry.iceCandidateQueue) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {}
    }
    entry.iceCandidateQueue = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    console.log("[rtc] sending answer to", peerId);
    this._signal(peerId, { type: "answer", sdp: pc.localDescription.sdp });
  }

  async _handleAnswer(peerId, sdp) {
    const entry = this.peerConns.get(peerId);
    if (!entry) return;
    const { pc } = entry;

    await pc.setRemoteDescription({ type: "answer", sdp });
    entry.remoteDescSet = true;

    // Flush any queued ICE candidates
    console.log(
      "[rtc] flushing",
      entry.iceCandidateQueue.length,
      "queued ICE candidates",
    );
    for (const candidate of entry.iceCandidateQueue) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {}
    }
    entry.iceCandidateQueue = [];
  }

  async _handleIce(peerId, candidate) {
    if (!candidate) return;
    const entry = this.peerConns.get(peerId);
    if (!entry) return;
    const { pc } = entry;

    if (!entry.remoteDescSet) {
      // Queue it — remote description not set yet
      console.log("[rtc] queuing ICE candidate from", peerId);
      entry.iceCandidateQueue.push(candidate);
    } else {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.log("[rtc] failed to add ICE candidate", e.message);
      }
    }
  }

  _bindDataChannel(dc, peerId) {
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
      console.log("[dc] data channel open with", peerId);
    };

    dc.onclose = () => {
      console.log("[dc] data channel closed with", peerId);
    };

    dc.onmessage = (event) => {
      this._handleFileMessage(peerId, event.data);
    };
  }

  // ── File transfer ──

  isPeerReady(peerId) {
    const entry = this.peerConns.get(peerId);
    const dc = this.dataChannels.get(peerId);
    return (
      entry?.pc.connectionState === "connected" && dc?.readyState === "open"
    );
  }

  sendFile(peerId, file, onProgress) {
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== "open") {
      throw new Error("Connection lost — wait a moment and try again");
    }

    dc.send(
      JSON.stringify({
        type: "FILE_OFFER",
        name: file.name,
        size: file.size,
        mime: file.type,
      }),
    );

    let offset = 0;
    const reader = new FileReader();

    const readNext = () =>
      reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));

    reader.onload = (e) => {
      dc.send(e.target.result);
      offset += e.target.result.byteLength;
      const pct = Math.round((offset / file.size) * 100);
      onProgress(pct);
      if (offset < file.size) {
        if (dc.bufferedAmount > 1024 * 1024) {
          setTimeout(readNext, 50);
        } else {
          readNext();
        }
      } else {
        dc.send(JSON.stringify({ type: "FILE_DONE" }));
        onProgress(100);
      }
    };

    readNext();
  }

  acceptFile() {
    if (!this.pendingReceive) return;
    const { peerId } = this.pendingReceive;
    this.pendingReceive.resolve();
    const state = this._receiveBuffers.get(peerId);
    if (state && state.done) this._triggerDownload(peerId);
  }

  declineFile() {
    if (this.pendingReceive) {
      const dc = this.dataChannels.get(this.pendingReceive.peerId);
      if (dc && dc.readyState === "open") {
        dc.send(JSON.stringify({ type: "FILE_DECLINED" }));
      }
      this.pendingReceive.reject();
      this.pendingReceive = null;
    }
  }

  _triggerDownload(senderId) {
    const state = this._receiveBuffers.get(senderId);
    if (!state) return;
    const blob = new Blob(state.chunks, {
      type: state.meta.mime || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.meta.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this._receiveBuffers.delete(senderId);
    this.onProgress(senderId, 100, "receive");
  }

  _handleFileMessage(peerId, data) {
    if (typeof data === "string") {
      const msg = JSON.parse(data);

      if (msg.type === "FILE_OFFER") {
        this._receiveBuffers.set(peerId, {
          chunks: [],
          meta: msg,
          accepted: false,
          done: false,
        });
        this.pendingReceive = {
          peerId,
          meta: msg,
          resolve: () => {
            const state = this._receiveBuffers.get(peerId);
            if (state) state.accepted = true;
            this.pendingReceive = null;
          },
          reject: () => {
            this._receiveBuffers.delete(peerId);
            this.pendingReceive = null;
          },
        };
        this.onFileOffer(peerId, msg);
      }

      if (msg.type === "FILE_DONE") {
        const state = this._receiveBuffers.get(peerId);
        if (!state) return;
        state.done = true;
        if (state.accepted) this._triggerDownload(peerId);
      }
    } else {
      const state = this._receiveBuffers.get(peerId);
      if (!state) return;
      state.chunks.push(data);
      const received = state.chunks.reduce((a, c) => a + c.byteLength, 0);
      this.onProgress(
        peerId,
        Math.round((received / state.meta.size) * 100),
        "receive",
      );
    }
  }

  _removePeer(peerId) {
    this._clearDisconnectTimer(peerId);
    const entry = this.peerConns.get(peerId);
    if (entry) entry.pc.close();
    this.peerConns.delete(peerId);
    this.dataChannels.delete(peerId);
    this._receiveBuffers.delete(peerId);
    this.onPeerLeave(peerId);
  }

  setId(newId) {
    // Close all existing connections
    for (const peerId of [...this.peerConns.keys()]) {
      this._removePeer(peerId);
    }
    // Close WebSocket connection
    if (this.ws) {
      this.ws.close();
    }
    // Update myId and save to sessionStorage (per-tab)
    this.myId = newId;
    sessionStorage.setItem("filedrop-my-id", newId);
    // Reconnect
    this._connect();
  }
}
