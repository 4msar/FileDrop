// main.js — UI wiring

import { FileSharePeer } from './peer.js'

// ── DOM refs ──
const myPeerIdEl      = document.getElementById('my-peer-id')
const statusMsg       = document.getElementById('status-msg')
const peersContainer  = document.getElementById('peers-container')

// Send modal
const sendModal       = document.getElementById('send-modal')
const modalPeerName   = document.getElementById('modal-peer-name')
const fileInput       = document.getElementById('file-input')
const fileNameDisplay = document.getElementById('file-name-display')
const sendBtn         = document.getElementById('send-btn')
const cancelBtn       = document.getElementById('cancel-btn')
const progressWrap    = document.getElementById('progress-wrap')
const progressFill    = document.getElementById('progress-fill')
const progressLabel   = document.getElementById('progress-label')

// Receive toast
const receiveToast    = document.getElementById('receive-toast')
const toastTitle      = document.getElementById('toast-title')
const toastFile       = document.getElementById('toast-file')
const acceptBtn       = document.getElementById('accept-btn')
const declineBtn      = document.getElementById('decline-btn')

// ── State ──
let activePeerId = null
const peerNodes  = new Map() // peerId → DOM element

// ── Peer positions on radar rings ──
const POSITIONS = [
  { x: 50, y: 22 },
  { x: 78, y: 50 },
  { x: 50, y: 78 },
  { x: 22, y: 50 },
  { x: 50, y: 10 },
  { x: 83, y: 28 },
  { x: 90, y: 60 },
  { x: 65, y: 88 },
  { x: 35, y: 88 },
  { x: 10, y: 60 },
  { x: 17, y: 28 },
]

function getPosition(index) {
  return POSITIONS[index % POSITIONS.length]
}

const AVATARS = [
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="13" r="7" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><path d="M9.5 16 Q12 17.5 14.5 16" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M8 7 Q9 5 10 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M14 7 Q15 5 16 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7" fill="currentColor" opacity="0.12" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="11.5" r="1.2" fill="currentColor"/><circle cx="14.5" cy="11.5" r="1.2" fill="currentColor"/><path d="M9 15.5 Q12 17 15 15.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><ellipse cx="12" cy="14" rx="2.5" ry="1.5" fill="currentColor" opacity="0.15"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="11" r="1.3" fill="currentColor"/><circle cx="14.5" cy="11" r="1.3" fill="currentColor"/><path d="M10 15.5 Q12 17 14 15.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M7 7 L9 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M17 7 L15 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="13" rx="7" ry="6" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="12" r="1.2" fill="currentColor"/><circle cx="14.5" cy="12" r="1.2" fill="currentColor"/><ellipse cx="12" cy="14.5" rx="2" ry="1.2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1"/><circle cx="7.5" cy="8" r="2" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1"/><circle cx="16.5" cy="8" r="2" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1"/></svg>`,
]

function getAvatar(index) {
  return AVATARS[index % AVATARS.length]
}

function peerLabel(peerId) {
  const parts = peerId.split('-')
  if (parts.length >= 2) {
    return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  }
  return peerId.slice(0, 10)
}

// ── Add peer node to radar ──
let peerCount = 0
function addPeerNode(peerId) {
  if (peerNodes.has(peerId)) return
  const pos = getPosition(peerCount)
  peerCount++

  const node = document.createElement('div')
  node.className = 'node peer-node'
  node.style.left = `${pos.x}%`
  node.style.top  = `${pos.y}%`
  node.dataset.peerId = peerId

  node.innerHTML = `
    <div class="avatar">${getAvatar(peerCount)}</div>
    <span>${peerLabel(peerId)}</span>
  `

  node.addEventListener('click', () => openSendModal(peerId))
  peersContainer.appendChild(node)
  peerNodes.set(peerId, node)

  setStatus(`${peerNodes.size} peer${peerNodes.size > 1 ? 's' : ''} nearby — click to send`)
}

function removePeerNode(peerId) {
  const node = peerNodes.get(peerId)
  if (node) {
    node.style.opacity = '0'
    node.style.transition = 'opacity 0.3s'
    setTimeout(() => node.remove(), 300)
    peerNodes.delete(peerId)
  }
  if (peerNodes.size === 0) setStatus('Waiting for peers on your network…')
  else setStatus(`${peerNodes.size} peer${peerNodes.size > 1 ? 's' : ''} nearby — click to send`)
}

function setStatus(text) {
  statusMsg.textContent = text
}

// ── Send modal ──
function openSendModal(peerId) {
  activePeerId = peerId
  modalPeerName.textContent = `Send to ${peerLabel(peerId)}`
  fileInput.value = ''
  fileNameDisplay.textContent = 'Select file'
  sendBtn.disabled = true
  progressWrap.classList.add('hidden')
  progressFill.style.width = '0%'
  progressLabel.textContent = '0%'
  sendModal.classList.remove('hidden')
}

function closeSendModal() {
  sendModal.classList.add('hidden')
  activePeerId = null
}

cancelBtn.addEventListener('click', closeSendModal)

sendModal.addEventListener('click', (e) => {
  if (e.target === sendModal) closeSendModal()
})

// ── File input — only wire the input's change event, no manual .click() ──
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]
  if (file) {
    fileNameDisplay.textContent = file.name
    sendBtn.disabled = false
  }
})

// Remove the redundant label click handler that was causing double open.
// The <label> in HTML wraps <input type="file"> so it already triggers it natively.

sendBtn.addEventListener('click', () => {
  const file = fileInput.files[0]
  if (!file || !activePeerId) return

  sendBtn.disabled = true
  cancelBtn.disabled = true
  progressWrap.classList.remove('hidden')

  try {
    fsp.sendFile(activePeerId, file, (pct) => {
      progressFill.style.width = `${pct}%`
      progressLabel.textContent = `${pct}%`
      if (pct === 100) {
        setTimeout(() => {
          closeSendModal()
          cancelBtn.disabled = false
        }, 700)
      }
    })
  } catch (err) {
    setStatus('Send failed: ' + err.message)
    closeSendModal()
    cancelBtn.disabled = false
  }
})

// ── Receive toast ──
function showReceiveToast(peerId, meta) {
  toastTitle.textContent = `Incoming from ${peerLabel(peerId)}`
  toastFile.textContent  = `${meta.name} · ${formatBytes(meta.size)}`
  receiveToast.classList.remove('hidden')
}

function hideReceiveToast() {
  receiveToast.classList.add('hidden')
}

acceptBtn.addEventListener('click', () => {
  fsp.acceptFile()
  hideReceiveToast()
})

declineBtn.addEventListener('click', () => {
  fsp.declineFile()
  hideReceiveToast()
})

// ── Helpers ──
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ── Init ──
const fsp = new FileSharePeer({
  onReady(id) {
    myPeerIdEl.textContent = id
    setStatus('Waiting for peers on your network…')
  },
  onPeerJoin(peerId) {
    addPeerNode(peerId)
  },
  onPeerLeave(peerId) {
    removePeerNode(peerId)
  },
  onFileOffer(peerId, meta) {
    showReceiveToast(peerId, meta)
  },
  onProgress(peerId, pct, direction) {
    // receive progress — kept simple
  },
  onError(msg) {
    setStatus('Error: ' + msg)
  }
})
