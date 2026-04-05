# FileDrop — P2P File Transfer

Simple peer-to-peer file sharing over the same network, inspired by ShareDrop.  
Built with plain HTML/CSS/JS + PeerJS + Vite. Deploys as a static site to Cloudflare Pages.

## How it works

- Each browser tab gets a unique ID via PeerJS (uses public STUN/TURN)
- Share your ID with someone on the same network (or paste theirs)
- Click their node → pick a file → send
- Receiver gets a toast notification → accepts → file downloads automatically
- No server stores your files — pure WebRTC P2P

## Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in two tabs (or two devices on same WiFi).

## Build

```bash
npm run build
# output in /dist — upload this folder anywhere static
```

## Deploy to Cloudflare Pages

### Manual drag & drop

```bash
npm run build
```
Go to Cloudflare Pages → Upload assets → drag the `dist/` folder.

## Customization

- **PeerJS server**: By default uses the free public PeerJS cloud server.  
  For production, self-host `peerjs-server`: https://github.com/peers/peerjs-server  
  Then update `peer.js` constructor options: `host`, `port`, `path`.

- **Peer discovery on LAN**: PeerJS uses STUN for WebRTC. For fully offline LAN-only usage,  
  run your own `peerjs-server` on the same network and remove the public STUN config.
