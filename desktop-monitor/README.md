# DENVique Desktop Monitor

DENVique Desktop Monitor is a signed-in desktop companion required for staff access to DENVique workspaces, including outside scheduled shifts.

## Capabilities

- Authenticates using the same active DENVique staff account (employee, team leader, quality, trainer, operations, account or executive) and the existing Auth0 login.
- Maintains a short-interval, server-verified connection session whenever staff use DENVique workspaces, regardless of shift time.
- Detects assigned shift windows, including the 30-minute pre-shift window.
- Outside scheduled shifts, records only app connection state and connection timestamps; it does not capture screens, app names or website domains.
- During an explicitly activated employee work shift, records full-screen captures from connected displays every five minutes.
- During an explicitly activated employee work shift, records foreground application names and (when configured) website domains only, not window titles or typed content.
- Supports a Chrome / Microsoft Edge extension that records website domains only.
- Pauses screen and activity capture during recorded breaks, while keeping the required portal connection active.
- Stops when the shift ends, the employee checks out, or monitoring is stopped.
- Does not use the camera or microphone for continuous monitoring.

The staff member sees the access and monitoring notice and must actively enable the connection. If the app or its activation is lost while a DENVique workspace is open, the workspace locks until the app reconnects. The Executive portal records connection and reconnection timestamps. The desktop app's local status endpoint accepts only the DENVique site origin.

## Install

Use the Mac DMG or Windows installer from the latest GitHub release. The Mac app is ad-hoc signed for bundle integrity but is not notarized by Apple because DENVique is using the free distribution route. On macOS, install it in Applications, then Control-click the app and choose Open once to approve it; grant Screen Recording and any requested Accessibility / Automation permissions in System Settings. After this one-time approval, launch it normally. Windows may show the standard SmartScreen unknown-publisher notice; choose More info → Run anyway for this build. Removing these first-run trust prompts completely requires paid platform code-signing credentials.

## Automatic updates

The employee interface is loaded from the live DENVique website, so page, layout, copy and server-side changes appear without reinstalling the desktop app. The monitoring engine is now kept separately from the stable Electron launcher: on both macOS and Windows, the launcher checks the latest DENVique GitHub release, downloads a newer engine over HTTPS, verifies its SHA-256 digest, and stages it in the app's private user-data folder. The verified engine becomes active automatically the next time the app is opened; employees do not need to download a new DMG or EXE for ordinary monitoring-engine changes.

Windows also keeps the Electron / Chromium shell updater through the NSIS installer feed, which downloads updates in the background and installs them when the app exits. On macOS, updates to Electron / Chromium itself still require a new DMG at present: Apple's supported automatic updater requires a consistent Developer ID code signature, which this free ad-hoc-signed build does not have. Changes to the monitoring engine and the live website interface do not require that DMG.

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
