# CLAUDE.md

Guidance for working in this repo.

## What this is

Stream Deck plugins that read battery levels straight off wireless peripherals
over HID, with no vendor daemon (NGenuity, G HUB) required. Windows only.

Two plugins, same architecture: one Node process per plugin, poll the device
every 60s, render the key as an SVG data URL, push it over the Stream Deck
plugin WebSocket API.

```
com.nightfury.hyperx-battery.sdPlugin/   HyperX Cloud III Wireless headset
com.nightfury.mouse-battery.sdPlugin/    Logitech PRO X 2 mouse
tray-app-csharp/                         headset tray app (C#) — current
tray-app/                                headset tray app (Electron) — older
rainmeter-skin/                          headset Rainmeter skin
```

Each `.sdPlugin` is self-contained: `manifest.json`, `app.js` (all the logic),
`launcher.bat`, `package.json`, `images/`. Dependencies are only `ws` and
`node-hid`. Keep it that way — small and dependency-light is the point.

## Verified hardware facts

**Do not re-derive these by guessing.** Each cost real debugging time, and the
failure mode is usually a plausible-but-wrong number rather than an error.

### HyperX Cloud III Wireless

- VID `0x03F0`, dongle PID `0x05B7`, usage page `0xFF13`
- Write 52 bytes, `buf[0]=0x66`, `buf[1]=0x89`, rest zeros — **no report-ID prefix**
- Read: **byte 4** is the level (0–100); `> 100` means off / out of range
- Never call `setNonBlocking()` — Windows hidapi doesn't support it
- **Charging is detectable, via enumeration rather than the payload.** The
  response carries no charging bit — every byte past the level is zero. But the
  headset appears as a **second USB device, PID `0x06B7`**, for exactly as long
  as the charging cable is connected. Presence of `0x06B7` = charging. Confirmed
  by watching an unplug: it vanished on the same 3-second tick the cable came
  out, and came back on reconnect.
- Both PIDs answer the same status request with an identical payload, so the
  cabled interface doubles as a fallback when the dongle is absent
- Bytes `2..3` are **big-endian millivolts**: 4189 mV at full charge, sagging to
  4063 mV once the cable was pulled. Not displayed, but useful for sanity checks.
- Earlier notes in this repo claimed charging was "not exposed by the protocol".
  That was wrong — it was concluded from the payload alone, without looking at
  what the USB bus was doing.
- An earlier spec claiming `[0x21, 0xFF, 0x05]` on usage page `0xFF00` with the
  level at byte 5 is **wrong**

### Logitech PRO X 2 (HID++ 2.0)

The mouse is **two different USB devices**, and only one exists at a time:

| Connection | PID | HID++ device index |
|---|---|---|
| Wireless (Lightspeed receiver) | `0xC54D` | `0x01` |
| Wired (charging cable) | `0xC09B` | `0xFF` |

Plugging in the cable makes the receiver **vanish from HID enumeration
completely**. Any code bound to a single PID goes blank exactly when you plug in
to charge. Hence `TRANSPORTS` in `app.js` and rediscovery across all of them.

- Vendor collections live on usage page `0xFF00`: usage `0x0001` = **short**
  reports (id `0x10`, 7 bytes), usage `0x0002` = **long** (id `0x11`, 20 bytes)
- Requests go out short; replies come back on **whichever collection fits the
  payload**. Open and read both.
- Request layout: `[0x10, deviceIndex, featureIndex, (funcIdx << 4) | swId, p0, p1, p2]`
- Battery: feature `0x1004` `UNIFIED_BATTERY`, resolved via root feature
  `getFeature`. On this mouse it lands at index **6**, but resolve it — don't
  hardcode.
- `getStatus` is **function 1**. Byte 4 = state of charge, byte 5 = level flags,
  byte 6 = charging status (1–3 = charging), byte 7 = external power.
- Feature `0x1000` (`BATTERY_STATUS`) is **not supported** on this mouse — it
  correctly resolves to index 0. Legacy support is retained only for other mice.

## Two traps

**Function 0 vs 1.** `getCapabilities` is function `0` on feature `0x1004` and
returns `15` in byte 4. Call it instead of `getStatus` (function `1`) and you get
a stable, believable `15%` that never changes.

**Reply correlation.** A `getFeature` reply contains only the resolved index — it
**does not echo the feature id it was asked about**. Consecutive lookups produce
replies with byte-identical headers, so a late reply to query N matches as the
answer to query N+1, shifting every answer one call late. The wrong feature gets
bound, the wrong function called, garbage rendered as a percentage.

Mitigation, already in `app.js` — keep it: rotate the HID++ **software id**
(1–15) per request via `nextSwId()`, and `drain()` both read queues before
writing. If you touch `exchange()`, preserve both.

## Testing

`mouse-battery/app.js` only calls `connect()` under `require.main === module`;
otherwise it exports its internals. So the read layer is testable directly:

```js
const m = require('.../com.nightfury.mouse-battery.sdPlugin/app.js');
m.readBattery();                    // { connected, level, charging }
m.openTransport(0xC09B);            // raw HID handle pair
m.getRoute();                       // what it currently has bound
```

**Verify against ground truth before trusting a rendered number.** Read the
device directly in a loop and confirm the value is stable and matches what the
plugin reports — a wrong-but-plausible percentage is the characteristic failure
here, and a single passing render proves nothing.

To exercise the full plugin without a physical deck, stand up a `ws` server,
spawn `app.js` with `-port/-pluginUUID/-registerEvent`, reply to its
`registerPlugin` with a `willAppear`, then base64-decode the `setImage` payload
and assert on the SVG. That catches registration, polling and rendering together.

For visual checks, render the SVG states to an HTML page and screenshot it —
`file:` URLs are blocked in the browser tooling, so serve over localhost.

Installed plugins live in `%APPDATA%\Elgato\StreamDeck\Plugins\`. Stream Deck
must be restarted to pick up changes; confirm the load in
`%APPDATA%\Elgato\StreamDeck\logs\StreamDeck.log` (look for `Plugin connected`).

## Conventions

- Match the existing style in `app.js`: section banner comments, terse helpers,
  no framework, no build step, no TypeScript.
- Both plugins must look identical on the deck — icon on top at y=52, percentage
  at y=104 (font-size 38, weight 900, Consolas), bar at y=122. Same colour
  thresholds: >50 green `#4ade80`, >20 yellow `#fbbf24`, else red `#ef4444`.
- Key icons are emoji rendered through `Segoe UI Emoji`. Verify any new glyph
  actually renders — `U+1F5B0` (trackball) comes out **blank**. `U+1F5B1` (mouse)
  and `U+1F3A7` (headphone) are fine. The mouse glyph is much narrower than the
  headset one, so it needs font-size 56 to match its optical weight.
- Never commit `node_modules/`.
- **No AI/assistant attribution in commits** — no `Co-Authored-By` trailers, no
  generated-with footers, no tooling directories.
