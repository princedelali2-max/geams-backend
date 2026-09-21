/**
 * GEAMS real-time client — drop-in replacement for the old localStorage-
 * based GeamsSync. Same public shape (available/getShared/setShared/
 * mergeShared/watch/ready/mode), so every existing call site in the six
 * apps (incidents, chat, officer roster, GPS broadcast) keeps working
 * completely unchanged — it just becomes genuinely real-time across
 * devices instead of only within one browser's tabs.
 *
 * Also adds call signaling (registerUserId/onSignal/sendSignal) for
 * real WebRTC voice/video between Civilian, LCR, and Dispatch.
 *
 * Configure GEAMS_BACKEND_URL/GEAMS_AUTH_TOKEN below (or override them
 * from the page before this script runs, e.g.
 *   <script>window.GEAMS_BACKEND_URL='wss://your-server/ws';</script>
 * ) to point at your deployed backend (see server.js/README.md). Left
 * blank, this correctly reports available()===false forever and every
 * app's existing offline/demo fallback keeps working exactly as before
 * — this was already how the apps were designed to degrade.
 */
const GeamsSync = (() => {
  const GEAMS_BACKEND_URL = (typeof window !== 'undefined' && window.GEAMS_BACKEND_URL) || '';
  const GEAMS_AUTH_TOKEN  = (typeof window !== 'undefined' && window.GEAMS_AUTH_TOKEN)  || '';

  const CLIENT_ID = (() => {
    try {
      let id = localStorage.getItem('geams_client_id');
      if (!id) {
        id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('geams_client_id', id);
      }
      return id;
    } catch (e) { return 'c_' + Math.random().toString(36).slice(2); }
  })();

  let mode = 'checking'; // 'connecting' | 'connected' | 'offline'
  let ws = null;
  let reconnectDelay = 1000;
  let reqCounter = 0;
  let myUserId = null;
  const pending = new Map();        // reqId -> resolve fn
  const watchers = new Map();       // key -> Set<cb>
  const localCache = new Map();     // key -> last known value (seeds watch() instantly, survives disconnects)
  const callListeners = new Set();  // cb(fromUserId, payload)
  let resolveReady;
  const readyPromise = new Promise((r) => { resolveReady = r; });

  function connect() {
    if (!GEAMS_BACKEND_URL) { mode = 'offline'; resolveReady(); return; }
    mode = 'connecting';
    let socket;
    try {
      const url = GEAMS_BACKEND_URL +
        (GEAMS_BACKEND_URL.includes('?') ? '&' : '?') +
        'clientId=' + encodeURIComponent(CLIENT_ID) + '&token=' + encodeURIComponent(GEAMS_AUTH_TOKEN);
      socket = new WebSocket(url);
    } catch (e) { mode = 'offline'; resolveReady(); scheduleReconnect(); return; }
    ws = socket;

    ws.onopen = () => {
      mode = 'connected';
      reconnectDelay = 1000;
      if (myUserId) send({ type:'register', userId: myUserId });
      for (const key of watchers.keys()) send({ type:'watch', key });
      resolveReady();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'result' && pending.has(msg.reqId)) {
        const resolve = pending.get(msg.reqId);
        pending.delete(msg.reqId);
        resolve(msg);
      } else if (msg.type === 'update') {
        localCache.set(msg.key, msg.value);
        const cbs = watchers.get(msg.key);
        if (cbs) cbs.forEach((cb) => { try { cb(msg.value); } catch (e) { console.error(e); } });
      } else if (msg.type === 'call') {
        callListeners.forEach((cb) => { try { cb(msg.fromUserId, msg.payload); } catch (e) { console.error(e); } });
      } else if (msg.type === 'pong') {
        /* heartbeat ack, nothing to do */
      }
    };

    ws.onclose = () => {
      const wasConnected = mode === 'connected';
      mode = 'offline';
      ws = null;
      // Fail every request in flight rather than hanging forever.
      for (const [id, resolve] of pending) resolve(null);
      pending.clear();
      if (wasConnected) console.warn('[GeamsSync] real-time connection lost — reconnecting…');
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows; handled there */ };
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }

  function send(obj) {
    if (ws && ws.readyState === ws.OPEN) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  function request(obj) {
    return new Promise((resolve) => {
      const reqId = ++reqCounter;
      if (!send(Object.assign({}, obj, { reqId }))) { resolve(null); return; }
      pending.set(reqId, resolve);
      setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve(null); } }, 8000);
    });
  }

  connect();

  function available() { return mode === 'connected'; }

  async function getShared(key, fallback) {
    await readyPromise;
    if (mode !== 'connected') return localCache.has(key) ? localCache.get(key) : fallback;
    const res = await request({ type:'get', key });
    if (res && res.ok) {
      const value = res.value === null || res.value === undefined ? fallback : res.value;
      localCache.set(key, value);
      return value;
    }
    return localCache.has(key) ? localCache.get(key) : fallback;
  }

  async function setShared(key, value) {
    await readyPromise;
    localCache.set(key, value);
    if (mode !== 'connected') return false;
    const res = await request({ type:'set', key, value });
    return !!(res && res.ok);
  }

  async function mergeShared(key, fallback, patchFn) {
    await readyPromise;
    try {
      const cur = await getShared(key, fallback);
      const next = patchFn(cur);
      return await setShared(key, next);
    } catch (e) { console.error('[GeamsSync] mergeShared failed:', e); return false; }
  }

  function watch(key, fallback, cb, /* intervalMs unused — real push now, kept for signature compat */ _intervalMs) {
    let stopped = false;
    if (!watchers.has(key)) watchers.set(key, new Set());
    watchers.get(key).add(cb);
    send({ type:'watch', key });
    // Fire once immediately so callers see something without waiting on
    // a full round trip — matches the old polling version's behavior of
    // calling back right away with whatever's available.
    getShared(key, fallback).then((v) => { if (!stopped) cb(v); });
    return () => {
      stopped = true;
      const set = watchers.get(key);
      if (set) {
        set.delete(cb);
        if (set.size === 0) { watchers.delete(key); send({ type:'unwatch', key }); }
      }
    };
  }

  /* ── CALL SIGNALING (WebRTC) ──────────────────────────────────────────
     A thin relay, not stored state: registerUserId ties this socket to
     a real identity (civilian id / officer badge / station id) so the
     server can route call.* messages to the right person; onSignal/
     sendSignal carry the offer/answer/ICE candidates. Building the
     actual RTCPeerConnection is left to each app (see the "real call"
     helper wired into the civilian/dispatch/station apps), since each
     needs slightly different UI around it. */
  function registerUserId(userId) {
    myUserId = userId;
    send({ type:'register', userId });
  }
  function onSignal(cb) { callListeners.add(cb); return () => callListeners.delete(cb); }
  function sendSignal(toUserId, payload) { return send({ type:'call', toUserId, payload }); }

  return {
    available, getShared, setShared, mergeShared, watch,
    ready: readyPromise, get mode() { return mode; }, get clientId() { return CLIENT_ID; },
    registerUserId, onSignal, sendSignal,
  };
})();
