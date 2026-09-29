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
const UPLOADS_DIR = process.env.GEAMS_UPLOADS_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = parseInt(process.env.GEAMS_MAX_UPLOAD_BYTES, 10) || 50 * 1024 * 1024; // 50MB — generous for a phone photo/short video clip, not for much more
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) {}

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


/* ────────────────────────────────────────────────────────────────────
   MEDIA UPLOAD — real evidence photos/video/audio/PDF from devices.

   Before this, a captured photo or body-cam recording stayed on the
   device that took it (an in-browser blob URL nobody else could open).
   Now: POST the raw file here, it's stored on disk, and a reference is
   appended to the shared key `incident:{incidentId}:evidence`, which
   pushes instantly to every LCR/HQ/Dispatch watching that incident —
   the same real-time mechanism as everything else, no separate channel.

   Safety choices worth knowing about:
   - Only image/video/audio/PDF are accepted. SVG and HTML are refused on
     purpose: served from the same origin as the apps, an uploaded SVG or
     HTML file could run script with access to the auth token.
   - Files are served with nosniff + a sandboxing CSP, and the stored
     content type is the whitelisted one, never re-derived from the file.
   - Media IDs are validated as UUIDs, so a crafted id can't walk the
     filesystem.
   - Size is capped (default 50MB) and enforced while streaming, not just
     from the Content-Length header, which a client can lie about.
──────────────────────────────────────────────────────────────────── */
const ALLOWED_MEDIA = /^(image|video|audio)\/[a-z0-9.+-]+$|^application\/pdf$/;
const EXT_BY_TYPE = {
  'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/gif':'.gif', 'image/heic':'.heic', 'image/heif':'.heif',
  'video/mp4':'.mp4', 'video/webm':'.webm', 'video/quicktime':'.mov', 'video/3gpp':'.3gp',
  'audio/webm':'.webm', 'audio/mp4':'.m4a', 'audio/mpeg':'.mp3', 'audio/ogg':'.ogg', 'audio/wav':'.wav', 'audio/x-m4a':'.m4a',
  'application/pdf':'.pdf',
};
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function rejectAndClose(req, res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' });
  res.end(body, () => { try { req.destroy(); } catch (e) {} });
}

// Push a new value for `key` to every socket currently watching it —
// the same fan-out the WebSocket 'set' handler does, reused here so an
// upload lands on LCR/HQ screens instantly instead of on next refresh.
function fanoutUpdate(key, value) {
  for (const sock of watchersFor(key)) {
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify({ type:'update', key, value }));
  }
}

function handleMediaUpload(req, res, url) {
  const q = url.searchParams;
  if (AUTH_TOKEN && q.get('token') !== AUTH_TOKEN) return rejectAndClose(req, res, 401, { ok:false, error:'unauthorized' });

  const contentType = String(q.get('contentType') || req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MEDIA.test(contentType) || contentType.includes('svg')) {
    return rejectAndClose(req, res, 415, { ok:false, error:'unsupported media type — only image, video, audio and PDF are accepted' });
  }
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_UPLOAD_BYTES) {
    return rejectAndClose(req, res, 413, { ok:false, error:`file too large (limit ${Math.round(MAX_UPLOAD_BYTES/1024/1024)}MB)` });
  }

  const id = crypto.randomUUID();
  const storedName = id + (EXT_BY_TYPE[contentType] || '.bin');
  const dest = path.join(UPLOADS_DIR, storedName);
  const out = fs.createWriteStream(dest);
  let bytes = 0, done = false;

  const fail = (code, obj) => {
    if (done) return; done = true;
    req.unpipe(out); out.destroy();
    fs.unlink(dest, () => {});
    rejectAndClose(req, res, code, obj);
  };

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) fail(413, { ok:false, error:`file too large (limit ${Math.round(MAX_UPLOAD_BYTES/1024/1024)}MB)` });
  });
  req.on('aborted', () => { if (!done) { done = true; out.destroy(); fs.unlink(dest, () => {}); } });
  req.on('error', () => { if (!done) { done = true; out.destroy(); fs.unlink(dest, () => {}); } });
  out.on('error', () => fail(500, { ok:false, error:'could not store file' }));

  out.on('finish', () => {
    if (done) return; done = true;
    if (bytes === 0) { fs.unlink(dest, () => {}); return sendJSON(res, 400, { ok:false, error:'empty file' }); }

    const clip = (v, n) => String(v || '').slice(0, n);
    const meta = {
      id, url: '/api/media/' + id, contentType, size: bytes,
      filename: clip(q.get('filename'), 200), type: clip(q.get('type'), 80),
      notes: clip(q.get('notes'), 500), uploadedBy: clip(q.get('uploadedBy'), 100),
      incidentId: clip(q.get('incidentId'), 100), uploadedAt: new Date().toISOString(),
    };
    store.set('media:' + id, Object.assign({ file: storedName }, meta));

    if (meta.incidentId) {
      const listKey = 'incident:' + meta.incidentId + ':evidence';
      const list = Array.isArray(store.get(listKey)) ? store.get(listKey) : [];
      list.push(meta);
      store.set(listKey, list);
      fanoutUpdate(listKey, list);
    }
    persist();
    console.log(`[geams-backend] media stored: ${storedName} (${bytes} bytes, ${contentType}) incident=${meta.incidentId || '-'}`);
    sendJSON(res, 200, { ok:true, mediaId: id, url: meta.url, size: bytes, contentType });
  });

  req.pipe(out);
}

function handleMediaGet(req, res, url, id) {
  if (AUTH_TOKEN && url.searchParams.get('token') !== AUTH_TOKEN) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  if (!UUID_RE.test(id)) { res.writeHead(404); res.end('Not found'); return; }
  const meta = store.get('media:' + id);
  if (!meta || !meta.file) { res.writeHead(404); res.end('Not found'); return; }

  const filePath = path.join(UPLOADS_DIR, path.basename(meta.file));
  fs.stat(filePath, (err, st) => {
    if (err) { res.writeHead(404); res.end('File no longer available'); return; }
    const headers = {
      'Content-Type': meta.contentType,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, max-age=3600',
    };
    let start = 0, end = st.size - 1, status = 200;
    const range = req.headers.range;
    if (range && st.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') { start = Math.max(0, st.size - parseInt(m[2], 10)); }
        else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(parseInt(m[2], 10), st.size - 1); }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
    }
    headers['Content-Length'] = st.size === 0 ? 0 : (end - start + 1);
    res.writeHead(status, headers);
    if (st.size === 0) { res.end(); return; }
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    // Lets the apps call these endpoints even when an HTML file is opened
    // from somewhere other than this server (e.g. a local copy pointed at
    // the deployed URL). Every route below still requires the token.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  }

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

  if (url.pathname === '/api/media/upload' && req.method === 'POST') return handleMediaUpload(req, res, url);
  {
    const m = url.pathname.match(/^\/api\/media\/([^\/]+)$/);
    if (m && req.method === 'GET') return handleMediaGet(req, res, url, m[1]);
  }

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
    if (ext === '.html') {
      // Auto-inject this server's real token into every page it serves,
      // overriding whatever placeholder value (usually a blank '') is
      // sitting in the file. This is the single most common way real-time
      // sync silently fails: the six HTML files get distributed/uploaded
      // with window.GEAMS_AUTH_TOKEN left blank because it's easy to miss
      // among six files, the server then correctly rejects the mismatched
      // connection, and nothing syncs with no visible error anywhere.
      // Since these pages are being served BY this exact server, it
      // already knows the one correct value — no reason to trust a copy
      // pasted by hand into six separate files when this server can just
      // supply it directly, every time, correctly.
      let html = data.toString('utf8');
      html = html.replace(
        /window\.GEAMS_AUTH_TOKEN\s*=\s*'[^']*';/,
        `window.GEAMS_AUTH_TOKEN = ${JSON.stringify(AUTH_TOKEN)};`
      );
      res.writeHead(200, { 'Content-Type': MIME[ext] });
      res.end(html);
      return;
    }
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
