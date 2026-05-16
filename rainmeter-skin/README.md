# HyperX Battery — Rainmeter skin

Desktop widget that shows the HyperX Cloud III Wireless battery level using the
same HID polling code as the tray app. Reads the headset over USB HID every 60
seconds and displays the percentage with green/amber/red color coding.

![skin preview placeholder](preview.png)

## How it works

Rainmeter doesn't have a native HID plugin, so this skin uses the built-in
`Plugin=RunCommand` measure to invoke a tiny helper exe (`HyperXBattery-cli.exe`,
~9 KB) that prints the battery level to stdout. The skin parses the output and
colors the text accordingly.

- `HyperXBattery-cli.exe` exits 0 with `<level>` (e.g. `85`) when connected
- Exits 1 with `DISCONNECTED` when the dongle is off or the headset is asleep
- Reuses `BatteryReader.cs` from the C# tray app — same VID/PID/usage page

## Install

1. Install [Rainmeter](https://www.rainmeter.net/) (4.0 or newer).
2. Download `HyperXBattery.rmskin` from the latest release.
3. Double-click the file. Rainmeter's Skin Installer will load it.
4. The skin will appear on your desktop. Right-click for the usual Rainmeter
   menu (move, lock, settings, etc.).

The skin folder ends up at `%USERPROFILE%\Documents\Rainmeter\Skins\HyperXBattery\`.

## Build from source

Requires Windows 10+ (for the bundled C# 5 compiler at
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`).

```powershell
cd rainmeter-skin
.\build.ps1
```

Output: `dist\HyperXBattery.rmskin`.

## Customizing

Edit `Skins\HyperXBattery\HyperXBattery.ini`:

- `Update` and `UpdateDivider` in `[MeasureBattery]` control polling cadence
  (default: every 60 s).
- `[Variables]` block defines colors and the box dimensions.
- The CLI exe path is `#@#HyperXBattery-cli.exe` (resolves to the
  `@Resources` folder inside the skin).

## Folder layout

```
rainmeter-skin/
├── RMSKIN.ini                                # Package manifest
├── Skins/
│   └── HyperXBattery/
│       ├── HyperXBattery.ini                 # The skin
│       └── @Resources/
│           └── HyperXBattery-cli.exe         # Copied in by build.ps1
├── build.ps1                                 # Build script
└── README.md
```

The CLI exe is not checked in — `build.ps1` builds it from `../tray-app-csharp/`
and copies it into place.
