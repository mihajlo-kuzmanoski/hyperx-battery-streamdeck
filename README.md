# NightfurY Peripherals

> Battery levels for wireless peripherals, on a Stream Deck key — read straight off the hardware, with no vendor software running in the background.

![Platform](https://img.shields.io/badge/platform-Windows-lightgrey?style=flat-square)
![Stream Deck](https://img.shields.io/badge/Stream%20Deck-6.8%2B-black?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What's in here

| Plugin | Device | Transport |
|---|---|---|
| [**HyperX Battery**](com.nightfury.hyperx-battery.sdPlugin) | HyperX Cloud III Wireless headset | USB dongle, raw HID |
| [**Mouse Battery**](com.nightfury.mouse-battery.sdPlugin) | Logitech PRO X 2 mouse | Lightspeed receiver **or** charging cable, HID++ 2.0 |

Extras for the headset: a [system tray app](tray-app-csharp) and a [Rainmeter skin](rainmeter-skin).

Both plugins share the same design: poll the device directly over HID every 60
seconds, render the key as an SVG, push it over the Stream Deck WebSocket API.
Same look on the deck — device icon on top, percentage below, a proportional bar
along the bottom.

|  | Colour |
|---|---|
| above 50% | green |
| 20–50% | yellow |
| below 20% | red |
| charging | shimmering bar + ⚡ badge |
| off / out of range | grey `--` |

---

## Why not just use the vendor software

Because it either isn't running or doesn't refresh. The motivating case: a
general-purpose monitoring plugin polled the mouse battery **once an hour**, and
when a read failed it sat on `N/A` until the next hourly tick — four hours of
`N/A` in the logs on more than one day. These plugins poll every 60 seconds, and
a key press forces an immediate re-read.

No NGenuity. No G HUB. Neither plugin needs the vendor daemon alive to work.

---

## Install

Per plugin:

1. Copy the `.sdPlugin` folder into `%APPDATA%\Elgato\StreamDeck\Plugins\`
2. `npm install` inside it (both need `ws` + `node-hid`)
3. Restart the Stream Deck software
4. Drag the action onto a key

Each plugin runs as one Node process, ~58 MB resident.

---

## Compatibility

| Device | Supported |
|---|---|
| HyperX Cloud III Wireless | ✅ |
| Logitech PRO X 2 — wireless, via receiver (`0xC54D`) | ✅ |
| Logitech PRO X 2 — wired, on the cable (`0xC09B`) | ✅ |
| Other Logitech HID++ 2.0 mice | ⚠️ add the PIDs to `TRANSPORTS` in `app.js` |
| Anything else | ❌ |

**OS:** Windows 10 / 11

---

## How the reads work

### HyperX Cloud III Wireless — raw HID

Open the dongle (VID `0x03F0`, PID `0x05B7`, usage page `0xFF13`), write a
52-byte request beginning `0x66 0x89`, read the reply. **Byte 4** is the battery
level; a value above 100 means the headset is off or out of range. Charging is
not exposed by this protocol at all.

Two things that cost real time to work out: there is **no report-ID prefix** on
the write, and `setNonBlocking()` must not be called — Windows hidapi doesn't
support it.

### Logitech PRO X 2 — HID++ 2.0

The mouse is **two different USB devices** depending on how it's connected, and
only one exists at any moment:

| Connection | USB device | HID++ device index |
|---|---|---|
| Wireless | Lightspeed receiver, PID `0xC54D` | `0x01` (pairing slot) |
| On the cable | the mouse itself, PID `0xC09B` | `0xFF` (direct attach) |

Plug in the cable and the receiver **disappears from HID enumeration entirely**.
It isn't that the mouse stops answering — the endpoint you were talking to ceases
to exist. Bind to only one and the key goes blank exactly when you plug in to
charge, which is when you actually want to watch the number climb. So the plugin
keeps a transport list and rediscovers across all of them whenever the cached
route stops answering.

Either endpoint exposes two vendor HID collections on usage page `0xFF00`: usage
`0x0001` carries **short** reports (id `0x10`), usage `0x0002` carries **long**
ones (id `0x11`). Requests go out short; replies arrive on whichever collection
fits the payload, so both are opened and both are read.

Per poll: resolve `UNIFIED_BATTERY` (feature `0x1004`) to its index via the root
feature's `getFeature`, then call **`getStatus`, function 1** — byte 4 is the
state of charge, byte 6 the charging status. The resolved route is cached, so
steady state is a single sub-second HID exchange.

---

## Two traps worth knowing about

Both of these produce *plausible, stable, completely wrong* readings rather than
an error, which is what makes them expensive.

**Function 0 vs function 1.** `getCapabilities` is function **0** on feature
`0x1004`, right next to `getStatus` at function **1**, and it returns `15` in
byte 4. Call the wrong one and the key shows a confident `15%` forever.

**Reply correlation.** A HID++ `getFeature` reply contains only the resolved
index — **it does not echo which feature id it was asked about**. Two consecutive
lookups therefore produce replies with identical headers (`deviceIndex`,
`featureIndex=0x00`, `funcByte`), so a late reply to the first query will happily
match as the answer to the second. Unhandled, that shifts every answer one call
late: the wrong feature gets bound, the wrong function is called on it, and
garbage renders as a percentage. The fix is to rotate the HID++ **software id**
(1–15) per request and drain both read queues before sending, so a stale reply
can never satisfy the current request.

---

## Layout

```
NightfurY-Peripherals/
├── com.nightfury.hyperx-battery.sdPlugin/   # headset plugin
├── com.nightfury.mouse-battery.sdPlugin/    # mouse plugin
├── tray-app-csharp/                         # headset tray app (C#)
├── tray-app/                                # headset tray app (Electron, older)
└── rainmeter-skin/                          # headset Rainmeter skin
```

Each `.sdPlugin` is self-contained:

```
manifest.json   # plugin metadata & action definitions
app.js          # all plugin logic (Node.js)
launcher.bat    # entry point Stream Deck invokes
package.json
images/         # action, category & plugin icons
```

Stream Deck launches `launcher.bat` with `-port`, `-pluginUUID` and
`-registerEvent`. The plugin registers over WebSocket and starts polling on
`willAppear`.

---

## License

MIT — see [LICENSE](LICENSE)
