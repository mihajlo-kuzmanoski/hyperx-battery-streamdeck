'use strict';

const WebSocket = require('ws');
const HID       = require('node-hid');

// ── Constants ────────────────────────────────────────────────
const VENDOR_ID  = 0x046D;   // Logitech
const USAGE_PAGE = 0xFF00;   // HID++ vendor collections
const POLL_MS    = 60_000;

// The PRO X 2 shows up as two entirely different USB devices depending on how
// it is connected, and only one of them exists at a time. On the cable the
// Lightspeed receiver disappears completely, so a plugin that only knows the
// receiver goes blank the moment you plug in to charge. Directly-attached HID++
// devices answer on device index 0xFF; through a receiver they answer on their
// pairing slot.
const TRANSPORTS = [
  { productId: 0xC54D, label: 'receiver', deviceIndexes: [0x01, 0x02] },
  { productId: 0xC09B, label: 'wired',    deviceIndexes: [0xFF, 0x01] },
];

const FEAT_ROOT        = 0x00;
const FEAT_UNIFIED     = 0x1004;   // UNIFIED_BATTERY
const FEAT_LEGACY      = 0x1000;   // BATTERY_STATUS
const FEATURE_TIMEOUT  = 600;
const STATUS_TIMEOUT   = 1200;

// ── HID++ transport ──────────────────────────────────────────
// Either endpoint exposes two vendor collections: usage 0x0001 carries short
// reports (id 0x10), usage 0x0002 carries long ones (id 0x11). Requests go out
// short; replies come back on whichever collection fits the payload.
function openTransport(productId) {
  const group = HID.devices().filter(d =>
    d.vendorId  === VENDOR_ID  &&
    d.productId === productId  &&
    d.usagePage === USAGE_PAGE
  );
  const shortInfo = group.find(d => d.usage === 0x0001);
  const longInfo  = group.find(d => d.usage === 0x0002);
  if (!shortInfo || !longInfo) return null;
  return { short: new HID.HID(shortInfo.path), long: new HID.HID(longInfo.path) };
}

function closeTransport(io) {
  for (const dev of [io.short, io.long]) {
    try { dev.close(); } catch (_) {}
  }
}

// A getFeature reply carries only the resolved index — it does not echo the
// feature id it was asked about, so consecutive lookups are indistinguishable by
// header alone. Rotating the software id per request keeps a late reply from
// being mistaken for the answer to the next one, and we drain whatever is still
// queued before sending. Without this the plugin binds the wrong feature and
// reads garbage as a percentage.
let swSeq = 0;
function nextSwId() {
  swSeq = (swSeq % 15) + 1;   // 1..15; 0 is reserved for device notifications
  return swSeq;
}

function drain(io) {
  for (const dev of [io.short, io.long]) {
    for (let i = 0; i < 32; i++) {
      let res;
      try { res = dev.readTimeout(1); } catch (_) { break; }
      if (!res || res.length === 0) break;
    }
  }
}

function exchange(io, devIdx, featIdx, funcIdx, params, timeoutMs) {
  drain(io);
  const funcByte = (funcIdx << 4) | nextSwId();
  const req = [0x10, devIdx, featIdx, funcByte, 0, 0, 0];
  for (let i = 0; i < params.length && i < 3; i++) req[4 + i] = params[i];
  io.short.write(req);

  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const dev of [io.short, io.long]) {
      let res;
      try { res = dev.readTimeout(40); } catch (_) { continue; }
      if (!res || res.length < 5) continue;
      if (res[1] !== devIdx) continue;                        // another paired device
      if (res[3] !== funcByte) continue;                      // stale or G HUB's traffic
      if (res[2] === 0xFF) return null;                       // HID++ error
      if (res[2] === featIdx) return res;
    }
  }
  return null;
}

// Root feature 0x0000, function 0 — resolve a feature id to its index.
// Index 0 means the device doesn't support it.
function featureIndex(io, devIdx, featureId) {
  const res = exchange(io, devIdx, FEAT_ROOT, 0x00,
    [(featureId >> 8) & 0xFF, featureId & 0xFF, 0x00], FEATURE_TIMEOUT);
  return res ? res[4] : 0;
}

// Returns { route, state } — a route is only handed back once a real reading has
// come through it, so we never bind something that can't actually be read.
function discoverOn(io, transport) {
  const plan = [
    { featureId: FEAT_UNIFIED, kind: 'unified', attempts: 2 },
    { featureId: FEAT_LEGACY,  kind: 'legacy',  attempts: 1 },
  ];
  for (const deviceIndex of transport.deviceIndexes) {
    for (const step of plan) {
      // The first exchange after opening can time out while the mouse wakes up,
      // so the preferred feature gets a second attempt.
      for (let attempt = 0; attempt < step.attempts; attempt++) {
        const idx = featureIndex(io, deviceIndex, step.featureId);
        if (!idx) continue;
        const route = {
          productId: transport.productId, transport: transport.label,
          deviceIndex, featureIndex: idx, kind: step.kind,
        };
        const state = readAt(io, route);
        if (state) return { route, state };
        break;
      }
    }
  }
  return null;
}

function readAt(io, route) {
  // unified: func 1 = getStatus  → stateOfCharge, batteryLevel, chargingStatus
  // legacy:  func 0 = getBatteryLevelStatus → dischargeLevel, nextLevel, status
  const funcIdx = route.kind === 'unified' ? 0x01 : 0x00;
  const res = exchange(io, route.deviceIndex, route.featureIndex, funcIdx, [], STATUS_TIMEOUT);
  if (!res) return null;
  const level = res[4];
  if (level > 100) return null;
  const charging = route.kind === 'unified'
    ? res[6] >= 1 && res[6] <= 3        // 1 charging, 2 slow, 3 complete
    : res[6] === 1 || res[6] === 4;     // 1 recharging, 4 slow recharge
  return { level, charging };
}

let route = null;

function readBattery() {
  // Cached route first — steady state is a single HID exchange.
  if (route) {
    let io = null;
    try {
      io = openTransport(route.productId);
      if (io) {
        const state = readAt(io, route);
        if (state) return { connected: true, ...state };
      }
    } catch (_) {
      // fall through to rediscovery
    } finally {
      if (io) closeTransport(io);
    }
  }

  // Rediscover across every transport. This is what carries us across a
  // wired/wireless switch: the endpoint we were bound to is simply gone, and the
  // other one has appeared in its place.
  for (const transport of TRANSPORTS) {
    let io = null;
    try {
      io = openTransport(transport.productId);
      if (!io) continue;
      const found = discoverOn(io, transport);
      if (found) {
        route = found.route;
        return { connected: true, ...found.state };
      }
    } catch (_) {
      // try the next transport
    } finally {
      if (io) closeTransport(io);
    }
  }
  route = null;
  return { connected: false };
}

// ── SVG renderer ─────────────────────────────────────────────
// U+1F5B1 three-button mouse. Written as an escape rather than a literal so the
// glyph survives any editor or git setting that would mangle astral-plane chars.
const MOUSE_EMOJI = '\u{1F5B1}\u{FE0F}';

function levelColor(pct) {
  if (pct > 50) return '#4ade80';
  if (pct > 20) return '#fbbf24';
  return '#ef4444';
}

function renderKey(state) {
  if (!state.connected) {
    return toDataUrl(buildSVG({ label:'--', color:'#666666', barWidth:0, charging:false }));
  }
  return toDataUrl(buildSVG({
    label:    `${state.level}%`,
    color:    levelColor(state.level),
    barWidth: state.level,
    charging: state.charging,
  }));
}

function buildSVG({ label, color, barWidth, charging }) {
  const shimmer = charging
    ? `<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%"   stop-color="${color}"/>
        <stop offset="50%"  stop-color="#93c5fd"/>
        <stop offset="100%" stop-color="${color}"/>
      </linearGradient></defs>` : '';
  const barFill = charging ? 'url(#g)' : color;
  const bolt    = charging
    ? `<text x="130" y="138" font-size="18" text-anchor="end" font-family="Segoe UI Emoji">⚡</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" fill="#000000" rx="12"/>
    ${shimmer}
    <text x="72" y="52" font-size="56" text-anchor="middle"
      dominant-baseline="middle" font-family="Segoe UI Emoji">${MOUSE_EMOJI}</text>
    <text x="72" y="104" font-size="38" font-weight="900"
      text-anchor="middle" fill="${color}" font-family="Consolas,monospace">${label}</text>
    <rect x="14" y="122" width="116" height="14" rx="6" fill="#222222"/>
    <rect x="14" y="122" width="${Math.round(barWidth * 1.16)}" height="14" rx="6" fill="${barFill}"/>
    ${bolt}
  </svg>`;
}

function toDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// ── Stream Deck WebSocket plugin ─────────────────────────────
const args     = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) =>
  v.startsWith('-') ? [...a, [v.slice(1), arr[i+1]]] : a, []));
const port          = args.port;
const pluginUUID    = args.pluginUUID;
const registerEvent = args.registerEvent;

const activeContexts = new Map();
const lastImage      = new Map(); // context → last sent image, skip redundant setImage calls

// Suppress transient read failures (mouse briefly asleep, G HUB holding the
// receiver) by holding the last good reading for a few polls before showing a
// disconnected state.
let cachedState = null;
let failStreak  = 0;
const FAIL_THRESH = 3;

function readBatteryStable() {
  const state = readBattery();
  if (state.connected) {
    cachedState = state;
    failStreak  = 0;
    return state;
  }
  failStreak++;
  if (cachedState && failStreak < FAIL_THRESH) return cachedState;
  return state;
}

let ws;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function pushImage(context) {
  const state = readBatteryStable();
  const image = renderKey(state);
  if (lastImage.get(context) === image) return;
  lastImage.set(context, image);
  send({
    event:   'setImage',
    context,
    payload: { image, target: 0 },
  });
}

function startPolling(context) {
  if (activeContexts.has(context)) stopPolling(context);
  pushImage(context);
  const timer = setInterval(() => pushImage(context), POLL_MS);
  activeContexts.set(context, timer);
}

function stopPolling(context) {
  const timer = activeContexts.get(context);
  if (timer) { clearInterval(timer); activeContexts.delete(context); }
  lastImage.delete(context);
}

function connect() {
  ws = new WebSocket(`ws://localhost:${String(port)}`);

  ws.on('open', () => {
    send({ event: registerEvent, uuid: pluginUUID });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.event === 'willAppear')    startPolling(msg.context);
    if (msg.event === 'willDisappear') stopPolling(msg.context);
    // Pressing the key forces an immediate re-read instead of waiting for the tick.
    if (msg.event === 'keyDown') { lastImage.delete(msg.context); pushImage(msg.context); }
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', () => process.exit(1));
}

if (require.main === module) {
  connect();
} else {
  // Loaded by the test harness — expose the read layer without opening a socket.
  module.exports = {
    TRANSPORTS, openTransport, closeTransport, exchange, featureIndex,
    discoverOn, readAt, readBattery, readBatteryStable, renderKey, buildSVG,
    getRoute: () => route,
    setRoute: (r) => { route = r; },
  };
}
