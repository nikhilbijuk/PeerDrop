/**
 * PeerDrop — Signaling Server
 * Lightweight WebSocket server that helps peers find each other.
 * Once peers are connected via WebRTC, this server is no longer involved.
 */

const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// MIME type map for static file serving
const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size }));
    return;
  }
  
  // Normalize and parse requested path (remove query params)
  const urlPath = req.url.split("?")[0];
  const normalizedPath = urlPath === "/" ? "index.html" : urlPath.substring(1);
  const safePath = path.normalize(normalizedPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(__dirname, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

const wss = new WebSocket.Server({ server });

// rooms: Map<roomCode, Map<peerId, ws>>
const rooms = new Map();

function generateRoomCode() {
  // 4-character alphanumeric code, excluding 0, O, 1, I, L
  const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; 
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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

// Group by IP helper
function getNearbyDevices(ip) {
  const list = [];
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.ip === ip &&
      !client.roomCode &&
      client.peerId
    ) {
      list.push({
        peerId: client.peerId,
        name: client.deviceName || "Unknown Device"
      });
    }
  }
  return list;
}

function sendNearbyDevices(ip) {
  const devices = getNearbyDevices(ip);
  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.ip === ip &&
      !client.roomCode
    ) {
      const filtered = devices.filter(d => d.peerId !== client.peerId);
      send(client, { type: "nearby-devices", devices: filtered });
    }
  }
}

// Periodic cleanup of stale connections (heartbeat check)
// Expire after 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.lastSeen) {
      if (now - client.lastSeen > 60000) {
        console.log(`[!] Peer ${client.peerId || 'unknown'} timed out (no heartbeat)`);
        client.terminate();
      }
    }
  }
}, 10000);

wss.on("connection", (ws, req) => {
  const peerId = generatePeerId();
  let currentRoom = null;

  // Track IP and metadata
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  ws.ip = clientIp;
  ws.peerId = peerId;
  ws.roomCode = null;
  ws.deviceName = "Unknown Device";
  ws.lastSeen = Date.now();

  console.log(`[+] New WS connection from ${clientIp}, assigned ID: ${peerId}`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Heartbeat ping update
    ws.lastSeen = Date.now();

    switch (msg.type) {
      case "ping": {
        send(ws, { type: "pong" });
        break;
      }

      // ── Register device details ─────────────────────────────────────────
      case "register": {
        ws.deviceName = msg.name || "Unknown Device";
        sendNearbyDevices(ws.ip);
        break;
      }

      // ── Create a new room ──────────────────────────────────────────────
      case "create": {
        let code;
        let attempts = 0;
        do { code = generateRoomCode(); attempts++; }
        while (rooms.has(code) && attempts < 20);

        rooms.set(code, new Map([[peerId, ws]]));
        currentRoom = code;
        ws.roomCode = code;

        send(ws, { type: "created", roomCode: code, peerId });
        console.log(`[+] Room ${code} created by ${peerId}`);
        sendNearbyDevices(ws.ip);
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
        if (peers.has(peerId)) return; // Ignore duplicate join from same peer

        if (peers.size >= 2) {
          // Kick the 2nd connection to make room
          const iterator = peers.entries();
          iterator.next(); // Skip creator
          const [oldPeerId, oldWs] = iterator.next().value;
          
          peers.delete(oldPeerId);
          if (oldWs) {
            oldWs.roomCode = null;
            try {
              send(oldWs, { type: "error", message: "Disconnected: Reconnected from elsewhere" });
              oldWs.close();
            } catch (e) {}
          }
          console.log(`[!] Kicked lingering peer ${oldPeerId} to allow new joiner`);
        }

        peers.set(peerId, ws);
        currentRoom = code;
        ws.roomCode  = code;

        send(ws, { type: "joined", roomCode: code, peerId });

        // Tell the existing peer to initiate the WebRTC offer
        broadcast(code, peerId, { type: "peer-joined", peerId });
        console.log(`[+] ${peerId} joined room ${code}`);
        sendNearbyDevices(ws.ip);
        break;
      }

      // ── Invite another peer directly ──────────────────────────────────
      case "invite": {
        const targetId = msg.targetPeerId;
        let targetWs = null;
        for (const client of wss.clients) {
          if (client.peerId === targetId && !client.roomCode) {
            targetWs = client;
            break;
          }
        }

        if (!targetWs) {
          send(ws, { type: "error", message: "Device is no longer available" });
          return;
        }

        // Create a room code
        let code;
        let attempts = 0;
        do { code = generateRoomCode(); attempts++; }
        while (rooms.has(code) && attempts < 20);

        rooms.set(code, new Map([[peerId, ws]]));
        currentRoom = code;
        ws.roomCode = code;

        // Notify creator A
        send(ws, { type: "created", roomCode: code, peerId });
        console.log(`[+] Room ${code} created by ${peerId} (via invite)`);

        // Send invite request to target B
        send(targetWs, { type: "invite-received", roomCode: code, senderName: ws.deviceName, senderPeerId: peerId });
        sendNearbyDevices(ws.ip);
        break;
      }

      // ── Decline an invite ──────────────────────────────────────────────
      case "decline": {
        const code = msg.roomCode;
        if (rooms.has(code)) {
          broadcast(code, peerId, { type: "invite-declined" });
          rooms.delete(code);
          ws.roomCode = null;
        }
        sendNearbyDevices(ws.ip);
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
    if (currentRoom) {
      const peers = rooms.get(currentRoom);
      if (peers) {
        peers.delete(peerId);
        broadcast(currentRoom, peerId, { type: "peer-left", peerId });
        if (peers.size === 0) {
          rooms.delete(currentRoom);
          console.log(`[-] Room ${currentRoom} deleted (empty)`);
        }
      }
    }
    console.log(`[-] ${peerId} disconnected`);
    sendNearbyDevices(ws.ip);
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
});

const os = require('os');

server.listen(PORT, () => {
  console.log(`\n🚀 PeerDrop local server running!`);
  console.log(`\n💻 Local access (this PC): http://localhost:${PORT}`);
  
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`📱 Network access (phone): http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`\n⚠️  Keep this window open while you are sharing files!`);
});
