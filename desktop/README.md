# DENVique Desktop

A lightweight Tauri 2 desktop shell for the live DENVique Hatchable application.

## Live-update behavior

The desktop app opens the production DENVique web application directly:

\`https://csconweb-remote.hatchable.site/\`

It does not bundle a second copy of the frontend, API, or database. Published website changes therefore arrive from the same live server. The native shell checks the root document's deployment ETag every 30 seconds. When Hatchable publishes a new version, the webview reloads automatically after 45 seconds without user activity and never while a text field, select, or contenteditable element is focused.

No installer update is needed for ordinary DENVique pages, styles, workflows, or backend changes. A new native installer is only needed if the Tauri/Rust shell itself changes.

## Build locally

Requirements: Rust stable, Node.js 22+, and the platform's Tauri prerequisites.

\`\`\`sh
cd desktop
npm install
npm run tauri -- icon src-tauri/icons/icon.svg
npm run tauri -- build
\`\`\`

## CI installers

The GitHub Actions workflow builds:
- macOS Apple Silicon \`.dmg\`
- macOS Intel \`.dmg\`
- Windows x64 NSIS \`.exe\`

Build artifacts are attached to the workflow run for download.

## Authentication and privacy

Login stays on the same DENVique origin and uses the existing Auth0 flow and server-issued session cookie. This app contains no credentials, API keys, customer data, or separate database. The user must sign in with their existing DENVique account.

## Distribution note

The initial builds are unsigned. macOS may require the user to right-click the app and choose Open, and Windows may show a SmartScreen warning. A smooth public release requires Apple Developer ID signing/notarization and Windows code-signing credentials.
