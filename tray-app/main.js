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
  const px = Buffer.alloc(W * H * 4);

  const BG = [18, 18, 18, 255];
  const TR = [45, 45, 45, 255];
  const FL = !connected  ? [85, 85, 85, 255] :
             level > 50  ? [74, 222, 128, 255] :
             level > 20  ? [251, 191, 36, 255] : [239, 68, 68, 255];

  // Thin battery bar centered vertically, full width
  const TX = 2, TY = 13, TW = 28, TH = 6;
  const fw = connected ? Math.max(1, Math.round(TW * level / 100)) : 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) << 2;
      let c = BG;
      if (y >= TY && y < TY + TH && x >= TX && x < TX + TW)
        c = x < TX + fw ? FL : TR;
      px[i] = c[0]; px[i+1] = c[1]; px[i+2] = c[2]; px[i+3] = c[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter byte
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
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
