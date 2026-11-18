'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

const REPO = 'gaber11222/denvique-website';
const MANIFEST_URL = 'https://github.com/' + REPO + '/releases/latest/download/DENVique-Monitor-update.json';
const RUNTIME_ASSET = 'DENVique-Monitor-runtime.cjs';
const MAC_ASSET = 'DENVique-Monitor-mac-arm64.zip';
const BUNDLE_ID = 'com.denvique.desktopmonitor';
const RUNTIME_DIR = () => path.join(app.getPath('userData'), 'runtime');
const ACTIVE_META = () => path.join(RUNTIME_DIR(), 'active-runtime.json');
const MAC_UPDATE_DIR = () => path.join(app.getPath('userData'), 'mac-app-updates');
const MAC_PENDING_FILE = () => path.join(MAC_UPDATE_DIR(), 'pending.json');
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024;
const MAX_MAC_UPDATE_BYTES = 350 * 1024 * 1024;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_PUBLIC_KEY_PATH = path.join(app.getAppPath(), 'update-signing-public.pem');

let activeRuntime = null;
let activeVersion = app.getVersion();
let checkInProgress = false;
let pendingMacUpdate = null;
let macUpdateHandoffStarted = false;
let updatePublicKey = null;

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const aa = parseVersion(a);
  const bb = parseVersion(b);
  if (!aa || !bb) return 0;
  for (let i = 0; i < 3; i++) {
    if (aa[i] > bb[i]) return 1;
    if (aa[i] < bb[i]) return -1;
  }
  return 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getUpdatePublicKey() {
  if (!updatePublicKey) updatePublicKey = fs.readFileSync(UPDATE_PUBLIC_KEY_PATH, 'utf8');
  return updatePublicKey;
}

function verifySignedManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || !parseVersion(manifest.version)) {
    throw new Error('Update manifest schema or version is invalid.');
  }
  const signatureText = String(manifest.signature || '');
  if (!/^[A-Za-z0-9+/]{80,100}={0,2}$/.test(signatureText)) {
    throw new Error('Update manifest has no valid publisher signature.');
  }
  const { signature, ...signedPayload } = manifest;
  const signatureBytes = Buffer.from(signatureText, 'base64');
  if (signatureBytes.length !== 64 ||
      !crypto.verify(null, Buffer.from(JSON.stringify(signedPayload)), getUpdatePublicKey(), signatureBytes)) {
    throw new Error('Update publisher signature verification failed.');
  }
  if (!manifest.runtime || manifest.runtime.file !== RUNTIME_ASSET ||
      !/^[a-f0-9]{64}$/i.test(String(manifest.runtime.sha256 || ''))) {
    throw new Error('Signed runtime update metadata is invalid.');
  }
  if (!manifest.macos || (
    manifest.macos.file !== MAC_ASSET ||
    !/^[a-f0-9]{64}$/i.test(String(manifest.macos.sha256 || '')) ||
    manifest.macos.bundleId !== BUNDLE_ID
  )) {
    throw new Error('Signed macOS update metadata is invalid.');
  }
  if (!manifest.windows || manifest.windows.file !== 'DENVique-Monitor-Setup.exe' ||
      !/^[a-f0-9]{64}$/i.test(String(manifest.windows.sha256 || ''))) {
    throw new Error('Signed Windows installer metadata is invalid.');
  }
  approvedAssetUrl(manifest.windows, 'DENVique-Monitor-Setup.exe');
  return true;
}

function approvedAssetUrl(asset, expectedFile) {
  const url = new URL(String(asset && asset.downloadUrl || ''));
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      !url.pathname.startsWith('/' + REPO + '/releases/download/') ||
      !url.pathname.endsWith('/' + expectedFile)) {
    throw new Error('Update source is not an approved DENVique GitHub release asset.');
  }
  return url.href;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(timeoutMs || 10000)
  });
  if (!response.ok) throw new Error('Update manifest returned HTTP ' + response.status);
  return response.json();
}

async function downloadVerifiedAsset(asset, expectedFile, maximumBytes, destination) {
  if (!asset || asset.file !== expectedFile || !/^[a-f0-9]{64}$/i.test(String(asset.sha256 || ''))) {
    throw new Error('Update asset metadata is invalid.');
  }
  const url = approvedAssetUrl(asset, expectedFile);
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(expectedFile + ' download returned HTTP ' + response.status);
  if (!response.body) throw new Error('Update download response has no body.');
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) throw new Error(expectedFile + ' exceeds the allowed download size.');

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.download';
  try { fs.unlinkSync(temporary); } catch (_) {}
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const digest = crypto.createHash('sha256');
  let totalBytes = 0;
  try {
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk);
      totalBytes += part.length;
      if (totalBytes > maximumBytes) {
        try { await response.body.cancel(); } catch (_) {}
        throw new Error(expectedFile + ' exceeds the allowed download size.');
      }
      digest.update(part);
      if (!output.write(part)) await once(output, 'drain');
    }
    output.end();
    await finished(output);
    if (!totalBytes || digest.digest('hex') !== asset.sha256.toLowerCase()) {
      throw new Error(expectedFile + ' SHA-256 verification failed.');
    }
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function readInstalledRuntime() {
  try {
    const meta = JSON.parse(fs.readFileSync(ACTIVE_META(), 'utf8'));
    if (!meta || !parseVersion(meta.version) || !/^[a-f0-9]{64}$/i.test(meta.sha256 || '')) return null;
    const filename = String(meta.filename || '');
    if (!/^engine-\d+\.\d+\.\d+\.cjs$/.test(filename)) return null;
    const file = path.join(RUNTIME_DIR(), filename);
    if (sha256(fs.readFileSync(file)) !== meta.sha256.toLowerCase()) return null;
    if (compareVersions(meta.version, app.getVersion()) <= 0) return null;
    return { file, version: meta.version };
  } catch (_) {
    return null;
  }
}

function loadCommonJsFromRuntime(filename) {
  const runtimeModule = new Module(filename, module);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(app.getAppPath());
  runtimeModule.load(filename);
  return runtimeModule.exports || {};
}

function loadEngine() {
  const installed = readInstalledRuntime();
  const bundled = path.join(app.getAppPath(), 'engine.js');
  const selected = installed ? installed.file : bundled;
  activeVersion = installed ? installed.version : app.getVersion();
  global.__DENViqueRuntimeMeta = {
    version: activeVersion,
    source: installed ? 'auto-updated-runtime' : 'bundled-runtime'
  };
  try {
    activeRuntime = loadCommonJsFromRuntime(selected);
    console.log('DENVique runtime loaded:', activeVersion, global.__DENViqueRuntimeMeta.source);
  } catch (error) {
    if (!installed) throw error;
    console.error('Saved DENVique runtime failed to load; using bundled runtime:', error);
    try { fs.unlinkSync(selected); } catch (_) {}
    activeVersion = app.getVersion();
    global.__DENViqueRuntimeMeta = { version: activeVersion, source: 'bundled-runtime-fallback' };
    activeRuntime = loadCommonJsFromRuntime(bundled);
  }
}

function readPendingMacUpdate() {
  try {
    const pending = JSON.parse(fs.readFileSync(MAC_PENDING_FILE(), 'utf8'));
    if (!pending || !parseVersion(pending.version) ||
        compareVersions(pending.version, app.getVersion()) <= 0 ||
        !/^[a-f0-9]{64}$/i.test(pending.sha256 || '') ||
        !/^[a-f0-9-]{20,60}$/i.test(pending.transactionId || '') ||
        !fs.existsSync(pending.archivePath) || !fs.existsSync(pending.helperPath)) return null;
    return pending;
  } catch (_) {
    return null;
  }
}

function markMacUpdateStartupSuccess() {
  if (process.platform !== 'darwin') return;
  try {
    const pending = JSON.parse(fs.readFileSync(MAC_PENDING_FILE(), 'utf8'));
    if (!pending || pending.version !== app.getVersion() || !pending.transactionId) return;
    const successPath = path.join(MAC_UPDATE_DIR(), 'success-' + pending.transactionId + '.json');
    fs.writeFileSync(successPath, JSON.stringify({
      version: app.getVersion(),
      transactionId: pending.transactionId,
      startedAt: new Date().toISOString()
    }), { mode: 0o600 });
    console.log('DENVique macOS update startup acknowledged:', app.getVersion());
  } catch (_) {}
}

async function stageMacFullUpdate(manifest) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !app.isPackaged ||
      compareVersions(manifest.version, app.getVersion()) <= 0 || pendingMacUpdate) return false;
  if (!manifest.macos) return false;
  const updateDir = MAC_UPDATE_DIR();
  fs.mkdirSync(updateDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(updateDir, 'DENVique-Monitor-' + manifest.version + '.zip');
  const helperSource = path.join(process.resourcesPath, 'mac-updater.sh');
  const helperPath = path.join(updateDir, 'mac-updater.sh');
  if (!fs.existsSync(helperSource)) throw new Error('The independent macOS updater helper is missing.');
  fs.copyFileSync(helperSource, helperPath);
  fs.chmodSync(helperPath, 0o700);
  await downloadVerifiedAsset(manifest.macos, MAC_ASSET, MAX_MAC_UPDATE_BYTES, archivePath);

  const transactionId = crypto.randomUUID();
  const pending = {
    version: manifest.version,
    sha256: manifest.macos.sha256.toLowerCase(),
    archivePath,
    helperPath,
    transactionId,
    bundleId: BUNDLE_ID,
    stagedAt: new Date().toISOString()
  };
  const temporary = MAC_PENDING_FILE() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(pending, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, MAC_PENDING_FILE());
  pendingMacUpdate = pending;
  console.log('Verified full macOS Electron update staged:', manifest.version);
  if (activeRuntime && typeof activeRuntime.notifyMacAppUpdateReady === 'function') {
    activeRuntime.notifyMacAppUpdateReady(manifest.version);
  }
  return true;
}

function startMacUpdateHandoff(event) {
  if (process.platform !== 'darwin' || !pendingMacUpdate || macUpdateHandoffStarted || event.defaultPrevented) return;
  event.preventDefault();
  macUpdateHandoffStarted = true;
  try {
    const child = spawn('/bin/sh', [
      pendingMacUpdate.helperPath,
      pendingMacUpdate.archivePath,
      process.execPath,
      app.getPath('userData'),
      pendingMacUpdate.version,
      pendingMacUpdate.sha256,
      String(process.pid),
      pendingMacUpdate.transactionId,
      pendingMacUpdate.bundleId
    ], { detached: true, stdio: 'ignore' });
    child.once('error', error => console.error('Could not start independent macOS updater:', error));
    child.unref();
    setTimeout(() => app.exit(0), 250);
  } catch (error) {
    macUpdateHandoffStarted = false;
    console.error('Could not hand off macOS update:', error);
    app.exit(0);
  }
}

async function checkAndStageUpdates() {
  if (!app.isPackaged || checkInProgress) return false;
  checkInProgress = true;
  try {
    const manifest = await fetchJson(MANIFEST_URL, 10000);
    verifySignedManifest(manifest);
    if(activeRuntime&&typeof activeRuntime.approveSignedUpdateManifest==='function'){
      activeRuntime.approveSignedUpdateManifest(manifest.version, manifest.windows);
    }
    const runtimeVersion = manifest.version;

    if (compareVersions(runtimeVersion, activeVersion) > 0) {
      const filename = 'engine-' + runtimeVersion + '.cjs';
      const destination = path.join(RUNTIME_DIR(), filename);
      let validExisting = false;
      try {
        validExisting = sha256(fs.readFileSync(destination)) === manifest.runtime.sha256.toLowerCase();
      } catch (_) {}
      if (!validExisting) {
        await downloadVerifiedAsset(manifest.runtime, RUNTIME_ASSET, MAX_RUNTIME_BYTES, destination);
      }
      const metadata = {
        version: runtimeVersion,
        filename,
        sha256: manifest.runtime.sha256.toLowerCase(),
        downloadedAt: new Date().toISOString()
      };
      const metaTemporary = ACTIVE_META() + '.tmp';
      fs.mkdirSync(RUNTIME_DIR(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(metaTemporary, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      fs.renameSync(metaTemporary, ACTIVE_META());

      const runtimeFiles = fs.readdirSync(RUNTIME_DIR())
        .filter(name => /^engine-\d+\.\d+\.\d+\.cjs$/.test(name))
        .sort((left, right) => compareVersions(right.slice(7, -4), left.slice(7, -4)));
      for (const staleFile of runtimeFiles.slice(2)) {
        try { fs.unlinkSync(path.join(RUNTIME_DIR(), staleFile)); } catch (_) {}
      }
      console.log('Verified signed DENVique runtime staged:', runtimeVersion);
      if (activeRuntime && typeof activeRuntime.notifyRuntimeUpdateReady === 'function') {
        activeRuntime.notifyRuntimeUpdateReady(runtimeVersion);
      }
    }

    if (process.platform === 'darwin' && process.arch === 'arm64' &&
        compareVersions(manifest.version, app.getVersion()) > 0) {
      await stageMacFullUpdate(manifest);
    }
    return true;
  } catch (error) {
    console.warn('DENVique signed update check skipped:', String(error && error.message || error).slice(0, 400));
    return false;
  } finally {
    checkInProgress = false;
  }
}

global.__DENViqueMarkUpdateStartupSuccess = markMacUpdateStartupSuccess;
loadEngine();

if (process.platform === 'darwin') {
  pendingMacUpdate = readPendingMacUpdate();
  app.on('before-quit', startMacUpdateHandoff);
}

if (app.isPackaged) {
  const firstCheck = setTimeout(() => checkAndStageUpdates(), 20000);
  if (firstCheck.unref) firstCheck.unref();
  const updateTimer = setInterval(() => checkAndStageUpdates(), CHECK_INTERVAL_MS);
  if (updateTimer.unref) updateTimer.unref();
}