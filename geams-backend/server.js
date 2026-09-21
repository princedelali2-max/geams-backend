#!/usr/bin/env node
'use strict';
/**
 * GEAMS Real-Time Backend
 * ────────────────────────
 * Replaces the localStorage-based GeamsSync (which only ever worked
 * between tabs of the SAME browser) with a real, network-reachable
 * WebSocket server. Three things live here:
 *
 *   1. A generic shared key/value store with get/set/merge + live push
 *      ("watch") — this is the exact same shape GeamsSync already
 *      exposed to every app, so the client library (geams-client.js)
 *      is a drop-in replacement and NONE of the six HTML apps' business
 *      logic (incidents, chat, officer roster, GPS position broadcast)
 *      needs to change. They already only depend on this interface.
 *
 *   2. A WebRTC signaling relay (call.invite/offer/answer/ice_candidate/
 *      end) keyed by a stable userId each client registers after
 *      connecting — used for live camera/voice between Civilian, LCR,
 *      and Dispatch. Media itself flows peer-to-peer once connected;
 *      only the signaling passes through here.
 *
 *   3. A pluggable SMS-notification endpoint for the civilian app's
 *      emergency-contacts feature. This is real, working plumbing —
 *      but actually delivering an SMS requires a real provider account
 *      (Twilio, Africa's Talking, etc.) and credentials only the
 *      deployer has. Without one configured, it honestly reports
 *      "not configured" rather than pretending to send anything.
 *
 * Also serves the six GEAMS HTML apps and geams-client.js as static
 * files, so the whole thing is one deployable unit.
 *
 * ── Deploy ──
 *   npm install
 *   GEAMS_AUTH_TOKEN=some-long-random-string node server.js
 *   # then point every device's GEAMS_BACKEND_URL / GEAMS_AUTH_TOKEN at
 *   # this server's public wss:// URL + the same token (see README.md)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.GEAMS_AUTH_TOKEN || '';
const DATA_FILE = process.env.GEAMS_DATA_FILE || path.join(__dirname, 'geams-data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!AUTH_TOKEN) {
  console.warn('[geams-backend] WARNING: GEAMS_AUTH_TOKEN is not set — anyone who finds this ' +
    'server\'s address can connect. Set a long random token before any real deployment:\n' +
    '  GEAMS_AUTH_TOKEN=$(node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))") node server.js');
}

/* ────────────────────────────────────────────────────────────────────
   PERSISTENCE — a plain JSON file is enough here: this store's job is
   "don't lose the last known state of a few thousand small keys", not
   high-throughput transactional writes. Loaded once at boot, written
   through on every change (debounced) so a server restart doesn't
   silently wipe every incident/chat/roster back to empty.
──────────────────────────────────────────────────────────────────── */
let store = new Map();
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const obj = JSON.parse(raw);
  store = new Map(Object.entries(obj));
  console.log(`[geams-backend] loaded ${store.size} keys from ${DATA_FILE}`);
} catch (e) {
  console.log('[geams-backend] no existing data file — starting empty');
}
let saveTimer = null;
function writeToDisk() {
  const obj = Object.fromEntries(store);
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj));
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeToDisk(); } catch (err) { console.error('[geams-backend] failed to persist data file:', err.message); }
  }, 500); // debounce — merge bursts of writes into one disk write
}
function flushPersist() {
  // Called on shutdown: write immediately and synchronously rather than
  // leaving up to 500ms of writes sitting only in memory when the
  // process exits (e.g. a redeploy) — the exact kind of silent data
  // loss a real emergency-response system can't afford.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { writeToDisk(); } catch (err) { console.error('[geams-backend] failed to flush data file on shutdown:', err.message); }
}

/* ────────────────────────────────────────────────────────────────────
   HTTP — static file serving for the six apps + client lib, plus one
   REST endpoint for the SMS-notification plumbing.
──────────────────────────────────────────────────────────────────── */
const MIME = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json', '.css':'text/css' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * SMS provider plug point. Real deployers wire ONE real provider in
 * here with their own account credentials (env vars) — this is where
 * an actual text message would be sent. Left unconfigured by default
 * so this honestly reports "not configured" rather than a fake success.
 *
 * Example (Africa's Talking, a common choice for Ghana deployments):
 *
 *   const AfricasTalking = require('africastalking')({
 *     apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME,
 *   }).SMS;
 *   async function sendSms(toPhone, text) {
 *     const r = await AfricasTalking.send({ to: [toPhone], message: text });
 *     return r.SMSMessageData.Recipients[0].status === 'Success';
 *   }
 *
 * Example (Twilio):
 *
 *   const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
 *   async function sendSms(toPhone, text) {
 *     const msg = await twilio.messages.create({ to: toPhone, from: process.env.TWILIO_FROM, body: text });
 *     return msg.status !== 'failed';
 *   }
 */
async function sendSms(toPhone, text) {
  return { configured: false, reason: 'No SMS provider wired in — see sendSms() in server.js' };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/notify-contact' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok:false, error:'bad json' }); }
      if (data.token !== AUTH_TOKEN) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
      if (!data.phone || !data.text) return sendJSON(res, 400, { ok:false, error:'phone and text required' });
      const result = await sendSms(data.phone, data.text);
      if (result && result.configured === false) {
        return sendJSON(res, 200, { ok:false, delivered:false, reason: result.reason });
      }
      return sendJSON(res, 200, { ok:true, delivered: !!result });
    });
    return;
  }

  if (url.pathname === '/api/health') return sendJSON(res, 200, { ok:true, keys: store.size, clients: wss.clients.size });

  // Friendly short links for each app — so a civilian, officer, or
  // commander just needs "your-server.onrender.com/civilian" rather than
  // the exact filename. Add more aliases here if you rename files.
  const ALIASES = {
    '/': '/index.html',
    '/civilian': '/geams-civilian-app.html',
    '/lcr': '/geams-station-dashboard.html',
    '/station': '/geams-station-dashboard.html',
    '/dispatch': '/geams-dispatch-app.html',
    '/fire': '/geams-fire-service.html',
    '/medical': '/geams-ambulance-service.html',
    '/ambulance': '/geams-ambulance-service.html',
    '/hq': '/geams-hq-dashboard.html',
  };

  // Static files (the six GEAMS apps + geams-client.js), for a fully
  // self-contained deployment. Anything else 404s.
  let rel = ALIASES[url.pathname] || url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ────────────────────────────────────────────────────────────────────
   WEBSOCKET — generic KV pub/sub + call signaling relay.
──────────────────────────────────────────────────────────────────── */
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => {
    // Reject BEFORE the WebSocket handshake completes (returns a real
    // HTTP 401), rather than accepting the connection and closing it a
    // moment later — cleaner for clients and doesn't briefly open a
    // socket for an unauthorized caller at all.
    if (!AUTH_TOKEN) { cb(true); return; } // no token configured — see startup warning
    const url = new URL(info.req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    if (token === AUTH_TOKEN) { cb(true); return; }
    cb(false, 401, 'Unauthorized');
  },
});

// key -> Set of sockets watching it
const watchersByKey = new Map();
// userId -> Set of sockets registered as that user (a user may have
// more than one device/tab connected at once)
const socketsByUserId = new Map();

function watchersFor(key) {
  if (!watchersByKey.has(key)) watchersByKey.set(key, new Set());
  return watchersByKey.get(key);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const clientId = url.searchParams.get('clientId') || crypto.randomUUID();

  ws.clientId = clientId;
  ws.userId = null;
  ws.watching = new Set();
  ws.isAlive = true;

  console.log(`[geams-backend] client connected: ${clientId} (${req.socket.remoteAddress})`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'register': {
        // Associates this socket with a stable real-world identity
        // (civilian id, officer badge, station id, HQ, etc.) so call
        // signaling can be routed to "the assigned officer" rather
        // than an anonymous per-tab connection.
        if (ws.userId && socketsByUserId.has(ws.userId)) socketsByUserId.get(ws.userId).delete(ws);
        ws.userId = String(msg.userId || '').slice(0, 200);
        if (!socketsByUserId.has(ws.userId)) socketsByUserId.set(ws.userId, new Set());
        socketsByUserId.get(ws.userId).add(ws);
        break;
      }

      case 'get': {
        const value = store.has(msg.key) ? store.get(msg.key) : null;
        ws.send(JSON.stringify({ type:'result', reqId: msg.reqId, ok:true, value }));
        break;
      }

      case 'set': {
        store.set(msg.key, msg.value);
        persist();
        ws.send(JSON.stringify({ type:'result', reqId: msg.reqId, ok:true }));
        // Push to every OTHER socket watching this key — this is the
        // real-time fanout that replaces the browser 'storage' event,
        // and unlike that event, it actually crosses devices/networks.
        for (const sock of watchersFor(msg.key)) {
          if (sock !== ws && sock.readyState === sock.OPEN) {
            sock.send(JSON.stringify({ type:'update', key: msg.key, value: msg.value }));
          }
        }
        break;
      }

      case 'watch': {
        watchersFor(msg.key).add(ws);
        ws.watching.add(msg.key);
        break;
      }

      case 'unwatch': {
        watchersFor(msg.key).delete(ws);
        ws.watching.delete(msg.key);
        break;
      }

      case 'call': {
        // WebRTC signaling relay: forward the payload verbatim to every
        // socket currently registered as msg.toUserId. If nobody is
        // connected as that user, tell the sender honestly rather than
        // silently dropping it (so the UI can show "offline", not hang).
        const targets = socketsByUserId.get(String(msg.toUserId || ''));
        if (targets && targets.size) {
          for (const sock of targets) {
            if (sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify({ type:'call', fromUserId: ws.userId, payload: msg.payload }));
            }
          }
        } else {
          ws.send(JSON.stringify({ type:'call', fromUserId: 'server', payload: { kind:'unreachable', toUserId: msg.toUserId } }));
        }
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type:'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const key of ws.watching) watchersFor(key).delete(ws);
    if (ws.userId && socketsByUserId.has(ws.userId)) {
      socketsByUserId.get(ws.userId).delete(ws);
      if (socketsByUserId.get(ws.userId).size === 0) socketsByUserId.delete(ws.userId);
    }
    console.log(`[geams-backend] client disconnected: ${clientId}`);
  });
});

// Heartbeat — drop sockets that stopped responding (phone locked, app
// backgrounded, network died) so watchersByKey/socketsByUserId don't
// silently accumulate dead entries, and so real disconnect is detected
// promptly rather than waiting on a TCP timeout.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

server.listen(PORT, () => {
  console.log(`[geams-backend] listening on :${PORT}  (ws endpoint: /ws, health: /api/health)`);
});

function shutdown() {
  clearInterval(heartbeat);
  flushPersist();
  wss.clients.forEach((ws) => ws.terminate()); // don't wait indefinitely on lingering clients
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000); // hard fallback
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
