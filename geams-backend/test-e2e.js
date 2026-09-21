// Simulates two separate devices: one sets/pushes data, the other
// watches it — exactly like an LCR device pushing an incident update
// and an HQ device (on a different network in real life) receiving it
// live. This is the actual mechanism GeamsSync's mergeShared/watch use.
const WebSocket = require('ws');

const TOKEN = 'test123';
const URL = `ws://localhost:8080/ws?token=${TOKEN}`;

function connect(clientId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${URL}&clientId=${clientId}`);
    ws.on('open', () => resolve(ws));
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

(async () => {
  let pass = true;
  const deviceA = await connect('device-A-civilian-phone');
  const deviceB = await connect('device-B-hq-dashboard');
  console.log('✓ both devices connected');

  // Test 1: basic set/get round trip
  await new Promise((resolve) => {
    deviceA.once('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'result' && msg.ok) console.log('✓ set() acknowledged by server');
      else { console.log('✗ set() failed', raw.toString()); pass = false; }
      resolve();
    });
    send(deviceA, { type: 'set', key: 'incident:TEST-001', value: { status: 'active' }, reqId: 1 });
  });

  // Test 2: device B watches the key BEFORE device A's next update, and
  // must receive it live (this is the actual real-time push, replacing
  // the browser 'storage' event that only worked same-browser).
  send(deviceB, { type: 'watch', key: 'incident:TEST-001' });
  await new Promise((r) => setTimeout(r, 200)); // let watch register server-side

  const received = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);
    deviceB.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'update' && msg.key === 'incident:TEST-001') {
        clearTimeout(timeout);
        resolve(msg.value);
      }
    });
    send(deviceA, { type: 'set', key: 'incident:TEST-001', value: { status: 'dispatched', officer: 'Sgt. Asante' }, reqId: 2 });
  });

  if (received && received.status === 'dispatched' && received.officer === 'Sgt. Asante') {
    console.log('✓ device B received device A\'s update in real time:', JSON.stringify(received));
  } else {
    console.log('✗ device B did NOT receive the real-time update. Got:', received);
    pass = false;
  }

  // Test 3: call signaling relay between two registered userIds
  send(deviceA, { type: 'register', userId: 'CIV-00847' });
  send(deviceB, { type: 'register', userId: 'OFFICER-GH-10237' });
  await new Promise((r) => setTimeout(r, 200));

  const callReceived = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);
    deviceB.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'call' && msg.payload && msg.payload.kind === 'offer') {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
    send(deviceA, { type: 'call', toUserId: 'OFFICER-GH-10237', payload: { kind: 'offer', sdp: 'fake-sdp-for-test' } });
  });

  if (callReceived && callReceived.fromUserId === 'CIV-00847') {
    console.log('✓ call signaling relayed correctly from civilian to officer:', JSON.stringify(callReceived));
  } else {
    console.log('✗ call signaling relay FAILED. Got:', callReceived);
    pass = false;
  }

  // Test 4: unreachable user reports back honestly instead of hanging
  const unreachable = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);
    deviceA.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'call' && msg.payload && msg.payload.kind === 'unreachable') {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
    send(deviceA, { type: 'call', toUserId: 'NOBODY-CONNECTED', payload: { kind: 'offer' } });
  });
  if (unreachable) console.log('✓ unreachable target correctly reported, not silently dropped');
  else { console.log('✗ unreachable target was silently dropped'); pass = false; }

  deviceA.close();
  deviceB.close();
  console.log(pass ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED');
  process.exit(pass ? 0 : 1);
})();
