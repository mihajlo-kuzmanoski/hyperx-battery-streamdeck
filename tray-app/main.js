'use strict';

const { app, Tray, Menu, nativeImage, Notification } = require('electron');
const HID  = require('node-hid');
const zlib = require('zlib');

// ── Config ─────────────────────────────────────────────────────
const VID      = 0x03F0;
const PID      = 0x05B7;
const UP       = 0xFF13;
const POLL_MS  = 60_000;
const LOW_WARN = 20;

app.setAppUserModelId('com.nightfury.hyperx-battery-tray');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ── HID ────────────────────────────────────────────────────────
let cachedState = null;
let failStreak  = 0;

function readBattery() {
  const info = HID.devices().find(d =>
    d.vendorId === VID && d.productId === PID && d.usagePage === UP
  );
  if (!info) return { connected: false };
  let dev;
  try {
    dev = new HID.HID(info.path);
    const req = Buffer.alloc(52, 0);
    req[0] = 0x66; req[1] = 0x89;
    dev.write(Array.from(req));
    const res = dev.readTimeout(1000);
    if (!res || res.length < 5 || res[4] > 100) return { connected: false };
    return { connected: true, level: res[4] };
  } catch { return { connected: false }; }
  finally { try { dev?.close(); } catch {} }
}

function readBatteryStable() {
  const s = readBattery();
  if (s.connected) { cachedState = s; failStreak = 0; return s; }
  if (++failStreak < 3 && cachedState) return cachedState;
  failStreak = 0; cachedState = null;
  return s;
}

// ── Icon (pure-JS PNG, no extra deps) ─────────────────────────
// 5×7 bitmap font — each entry is 7 row values, 5 bits MSB-first per row
const FONT = {
  '0': [14,17,17,17,17,17,14],
  '1': [4,12,4,4,4,4,14],
  '2': [14,17,1,6,8,16,31],
  '3': [14,17,1,6,1,17,14],
  '4': [2,6,10,18,31,2,2],
  '5': [31,16,30,1,1,17,14],
  '6': [14,16,16,30,17,17,14],
  '7': [31,1,1,2,4,8,8],
  '8': [14,17,17,14,17,17,14],
  '9': [14,17,17,15,1,17,14],
  '%': [25,26,4,8,19,3,3],
  '-': [0,0,0,31,0,0,0],
};

function createIcon(level, connected) {
  const crcT = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 8; j--;) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcT[i] = c;
  }
  const crc32 = (b) => {
    let c = 0xFFFFFFFF;
    for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const hdr = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(hdr));
    return Buffer.concat([len, hdr, crc]);
  };

  const W = 32, H = 32;
  const [r, g, b] = !connected  ? [85, 85, 85] :
                    level > 50  ? [74, 222, 128] :
                    level > 20  ? [251, 191, 36] : [239, 68, 68];

  const GW = 5, GH = 7, SP = 1;
  const text = connected ? `${level}%` : '--';
  const textW = text.length * GW + (text.length - 1) * SP;
  const ox0 = Math.floor((W - textW) / 2);
  const oy0 = Math.floor((H - GH) / 2);

  // Collect lit pixel indices
  const lit = new Set();
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = FONT[text[ci]] ?? FONT['-'];
    const cx = ox0 + ci * (GW + SP);
    for (let gy = 0; gy < GH; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < GW; gx++) {
        if (row & (1 << (GW - 1 - gx))) {
          const col = cx + gx, py = oy0 + gy;
          if (py >= 0 && py < H && col >= 0 && col < W)
            lit.add(py * W + col);
        }
      }
    }
  }

  // Render with glow: neighbors at distance ≤2 get a falloff alpha
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const i = idx << 2;
      if (lit.has(idx)) {
        buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
      } else {
        let maxA = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W || !lit.has(ny * W + nx)) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          const a = d <= 1 ? 160 : d <= 1.5 ? 90 : 40;
          if (a > maxA) maxA = a;
        }
        const t = maxA / 255;
        buf[i]   = Math.round(18 * (1 - t) + r * t);
        buf[i+1] = Math.round(18 * (1 - t) + g * t);
        buf[i+2] = Math.round(18 * (1 - t) + b * t);
        buf[i+3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter byte
    buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return nativeImage.createFromBuffer(png);
}

// ── Tray ───────────────────────────────────────────────────────
let tray    = null;
let alerted = false;

function update() {
  const s     = readBatteryStable();
  const label = s.connected ? `${s.level}%` : 'Disconnected';

  tray.setImage(createIcon(s.connected ? s.level : 0, s.connected));
  tray.setToolTip(`HyperX Battery: ${label}`);

  const atLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `HyperX Battery  ·  ${label}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Launch at startup',
      type: 'checkbox',
      checked: atLogin,
      click: () => app.setLoginItemSettings({ openAtLogin: !atLogin }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));

  if (s.connected && s.level <= LOW_WARN && !alerted) {
    alerted = true;
    new Notification({
      title: 'HyperX Battery Low',
      body:  `Battery is at ${s.level}% — plug in to charge`,
    }).show();
  }
  if (!s.connected || s.level > LOW_WARN) alerted = false;
}

app.whenReady().then(() => {
  tray = new Tray(createIcon(0, false));
  tray.on('click', () => tray.popUpContextMenu());
  update();
  setInterval(update, POLL_MS);
});

app.on('window-all-closed', () => {}); // keep alive — tray-only app
