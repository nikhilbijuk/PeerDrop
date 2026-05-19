# 🔗 PeerDrop — P2P File, Text & Screen Sharing

Share files, text snippets, and your screen **directly** between browsers.  
No cloud storage. No data passes through any server once peers are connected.

---

## How it works

```
Peer A  ──┐                        ┌── Peer B
           │  WebSocket (signaling) │
           └──── Signaling Server ──┘
                 (only for setup)

Peer A  ────────── WebRTC ──────────── Peer B
           (direct peer-to-peer data)
```

The signaling server only helps peers *find each other* via a room code.
After that, all file, text, and screen data flows **directly** between browsers.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the signaling server
```bash
npm start
# or for development with auto-restart:
npm run dev
```

The server runs on `ws://localhost:3000` by default.

### 3. Open the app
Open `index.html` in your browser. Both peers need access to it.

> **For local testing:** Open two browser tabs or windows on the same machine.  
> **For LAN sharing:** Host `index.html` on any static file server, e.g.:
> ```bash
> npx serve .
> ```
> Then both peers open the same IP address.

---

## Usage

1. **Peer A** clicks **Create room** → gets a code like `FIRE-1234`
2. **Peer B** clicks **Join room** → enters the code
3. WebRTC handshake happens automatically — you'll see "P2P CONNECTED"
4. Now share:
   - **Files tab**: drag & drop or browse files (any size)
   - **Text tab**: paste text, code, links, etc.
   - **Screen tab**: share your display live

---

## Deploying to production

### Signaling server
Deploy `server.js` to any Node.js host (Railway, Fly.io, Render, etc.):

```bash
# Example with Railway
railway up
```

### Frontend
In `index.html`, update the `WS_URL` line:

```js
const WS_URL = `wss://your-server.example.com`;  // use wss:// for HTTPS
```

Then host `index.html` on any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages).

---

## Tech stack

| Piece | Technology |
|---|---|
| Signaling | Node.js + `ws` (WebSockets) |
| P2P transport | WebRTC (RTCPeerConnection) |
| File transfer | WebRTC Data Channels (binary) |
| Screen sharing | `getDisplayMedia` + RTCPeerConnection tracks |
| UI | Vanilla HTML/CSS/JS (no framework) |

---

## Notes
- **Max 2 peers per room** (full mesh; expand for groups)
- File transfers use 64 KB chunks with flow control
- STUN servers from Google are used for NAT traversal (free, no signup)
- For users behind strict corporate firewalls, add a TURN server to `ICE_SERVERS`
