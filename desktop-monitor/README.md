# DENVique Desktop Monitor

DENVique Desktop Monitor is a signed-in desktop companion for employee shift attendance and consent-based work monitoring.

## Capabilities

- Authenticates using the DENVique employee account and existing Auth0 session.
- Detects assigned shift windows, including the 30-minute pre-shift window.
- Records full-screen captures from connected displays during an activated work session.
- Records foreground application names only (not window titles or typed content).
- Supports a Chrome / Microsoft Edge extension that records website domains only.
- Pauses capture and activity reporting during recorded breaks.
- Stops when the shift ends, the employee checks out, or monitoring is stopped.
- Does not use the camera or microphone for continuous monitoring.

The employee sees the work-monitoring notice and actively enables the session. The application shows its current monitoring state.

## Install

Use the Mac DMG or Windows installer from the latest GitHub release. This first build is unsigned; on macOS, the user may need to approve the app in Privacy & Security and grant Screen Recording access. Windows may show the standard SmartScreen publisher warning until a code-signing certificate is configured.

## Optional browser extension

1. Open the desktop app and select Open extension folder.
2. In Chrome, open chrome://extensions; in Edge, open edge://extensions.
3. Enable Developer mode.
4. Select Load unpacked and choose the desktop-monitor/extension folder from this repository.
5. Keep the desktop application connected during the work session.

The extension records the active website hostname only; it does not read page content, credentials, messages, URL paths or query strings.

## Build from source

Requires Node.js 22 or later.

From the desktop-monitor folder, run: npm install, npm start, npm run build:mac, or npm run build:win.

Builds are also produced by the GitHub Actions workflow at .github/workflows/build-desktop-monitor.yml.
