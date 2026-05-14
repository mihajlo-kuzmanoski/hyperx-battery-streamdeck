'use strict';

const WebSocket = require('ws');
const HID       = require('node-hid');

// ── Constants ────────────────────────────────────────────────
const VENDOR_ID  = 0x03F0;
const PRODUCT_ID = 0x05B7;
const USAGE_PAGE = 0xFF13;
const POLL_MS    = 60_000;

// ── HID reader ───────────────────────────────────────────────
function findDevice() {
  return HID.devices().find(d =>
    d.vendorId  === VENDOR_ID  &&
    d.productId === PRODUCT_ID &&
    d.usagePage === USAGE_PAGE
  );
}

function readBattery() {
  const info = findDevice();
  if (!info) return { connected: false };
  let dev;
  try {
    dev = new HID.HID(info.path);
    const req = Buffer.alloc(52, 0);
    req[0] = 0x66;
    req[1] = 0x89;
    dev.write(Array.from(req));
    const res = dev.readTimeout(1000);
    if (!res || res.length < 5) return { connected: false };
    const level = res[4];
    if (level > 100) return { connected: false };
    return { connected: true, charging: false, level };
  } catch (_) {
    return { connected: false };
  } finally {
    try { if (dev) dev.close(); } catch (_) {}
  }
}

// ── SVG renderer ─────────────────────────────────────────────
function levelColor(pct) {
  if (pct > 50) return '#4ade80';
  if (pct > 20) return '#fbbf24';
  return '#ef4444';
}

function renderKey(state) {
  if (!state.connected) {
    return toDataUrl(buildSVG({ emoji:'🎧', label:'--', color:'#666666', barWidth:0, charging:false }));
  }
  return toDataUrl(buildSVG({
    emoji:    '🎧',
    label:    `${state.level}%`,
    color:    levelColor(state.level),
    barWidth: state.level,
    charging: state.charging,
  }));
}

function buildSVG({ emoji, label, color, barWidth, charging }) {
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
    <text x="72" y="52" font-size="44" text-anchor="middle"
      dominant-baseline="middle" font-family="Segoe UI Emoji">${emoji}</text>
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

// Suppress transient HID failures (e.g. G Hub briefly holding the device)
// Only show disconnected after this many consecutive read failures.
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
  ws = new WebSocket(`ws://localhost:${port}`);

  ws.on('open', () => {
    send({ event: registerEvent, uuid: pluginUUID });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.event === 'willAppear')    startPolling(msg.context);
    if (msg.event === 'willDisappear') stopPolling(msg.context);
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', () => process.exit(1));
}

connect();
