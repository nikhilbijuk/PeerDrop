/**
 * PeerDrop — Signaling Server
 * Lightweight WebSocket server that helps peers find each other.
 * Once peers are connected via WebRTC, this server is no longer involved.
 */

const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

// rooms: Map<roomCode, Map<peerId, ws>>
const rooms = new Map();

function generateRoomCode() {
  // e.g. "XKCD-7291"
  const words = ["FIRE","WAVE","ECHO","TIDE","BOLT","MIST","GLOW","FLUX","SYNC","BEAM"];
  const word = words[Math.floor(Math.random() * words.length)];
  const num  = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${num}`;
}

function generatePeerId() {
  return crypto.randomBytes(4).toString("hex");
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, senderId, data) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const [id, ws] of peers) {
    if (id !== senderId) send(ws, data);
  }
}

wss.on("connection", (ws) => {
  const peerId = generatePeerId();
  let currentRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ── Create a new room ──────────────────────────────────────────────
      case "create": {
        let code;
        let attempts = 0;
        do { code = generateRoomCode(); attempts++; }
        while (rooms.has(code) && attempts < 20);

        rooms.set(code, new Map([[peerId, ws]]));
        currentRoom = code;
        ws.roomCode = code;
        ws.peerId   = peerId;

        send(ws, { type: "created", roomCode: code, peerId });
        console.log(`[+] Room ${code} created by ${peerId}`);
        break;
      }

      // ── Join an existing room ──────────────────────────────────────────
      case "join": {
        const code = (msg.roomCode || "").toUpperCase().trim();
        if (!rooms.has(code)) {
          send(ws, { type: "error", message: "Room not found" });
          return;
        }
        const peers = rooms.get(code);
        if (peers.size >= 2) {
          send(ws, { type: "error", message: "Room is full (max 2 peers)" });
          return;
        }

        peers.set(peerId, ws);
        currentRoom = code;
        ws.roomCode  = code;
        ws.peerId    = peerId;

        send(ws, { type: "joined", roomCode: code, peerId });

        // Tell the existing peer to initiate the WebRTC offer
        broadcast(code, peerId, { type: "peer-joined", peerId });
        console.log(`[+] ${peerId} joined room ${code}`);
        break;
      }

      // ── WebRTC signaling passthrough ───────────────────────────────────
      case "offer":
      case "answer":
      case "ice-candidate": {
        if (!currentRoom) return;
        broadcast(currentRoom, peerId, { ...msg, from: peerId });
        break;
      }

      // ── Chat / signal passthrough ──────────────────────────────────────
      case "signal": {
        if (!currentRoom) return;
        broadcast(currentRoom, peerId, { ...msg, from: peerId });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers) {
      peers.delete(peerId);
      broadcast(currentRoom, peerId, { type: "peer-left", peerId });
      if (peers.size === 0) {
        rooms.delete(currentRoom);
        console.log(`[-] Room ${currentRoom} deleted (empty)`);
      }
    }
    console.log(`[-] ${peerId} disconnected from ${currentRoom}`);
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
});

server.listen(PORT, () => {
  console.log(`\n🚀 PeerDrop signaling server running on ws://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
