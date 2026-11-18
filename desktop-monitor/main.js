'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const REPO = 'gaber11222/denvique-website';
const MANIFEST_URL = 'https://github.com/' + REPO + '/releases/latest/download/DENVique-Monitor-runtime.json';
const RUNTIME_ASSET = 'DENVique-Monitor-runtime.cjs';
const RUNTIME_DIR = () => path.join(app.getPath('userData'), 'runtime');
const ACTIVE_META = () => path.join(RUNTIME_DIR(), 'active-runtime.json');
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
let activeRuntime = null;
let activeVersion = app.getVersion();
let checkInProgress = false;

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

function readInstalledRuntime() {
  try {
    const meta = JSON.parse(fs.readFileSync(ACTIVE_META(), 'utf8'));
    if (!meta || !parseVersion(meta.version) || !/^[a-f0-9]{64}$/i.test(meta.sha256 || '')) return null;
    const filename = String(meta.filename || '');
    if (!/^engine-\d+\.\d+\.\d+\.cjs$/.test(filename)) return null;
    const file = path.join(RUNTIME_DIR(), filename);
    const data = fs.readFileSync(file);
    if (sha256(data) !== meta.sha256.toLowerCase()) return null;
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

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(timeoutMs || 7000)
  });
  if (!response.ok) throw new Error('Update manifest returned HTTP ' + response.status);
  return response.json();
}

async function downloadRuntime(assetUrl, expectedHash) {
  const url = new URL(assetUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      !url.pathname.startsWith('/' + REPO + '/releases/download/') ||
      !url.pathname.endsWith('/' + RUNTIME_ASSET)) {
    throw new Error('Update source is not an approved DENVique GitHub release asset.');
  }

  const response = await fetch(url.href, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Runtime download returned HTTP ' + response.status);

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RUNTIME_BYTES) throw new Error('Runtime update exceeds the allowed size.');

  if (!response.body) throw new Error('Runtime update response has no body.');
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const part = Buffer.from(chunk);
    totalBytes += part.length;
    if (totalBytes > MAX_RUNTIME_BYTES) {
      try { await response.body.cancel(); } catch (_) {}
      throw new Error('Runtime update exceeds the allowed size.');
    }
    chunks.push(part);
  }
  const data = Buffer.concat(chunks, totalBytes);
  if (!data.length) throw new Error('Runtime update is empty.');
  if (sha256(data) !== expectedHash.toLowerCase()) throw new Error('Runtime update checksum verification failed.');
  return data;
}

async function checkAndStageRuntimeUpdate() {
  if (!app.isPackaged || checkInProgress) return false;
  checkInProgress = true;
  try {
    const manifest = await fetchJson(MANIFEST_URL, 7000);
    const version = String(manifest.version || '');
    const hash = String(manifest.sha256 || '');
    const assetUrl = String(manifest.downloadUrl || '');

    if (!parseVersion(version) || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error('Runtime update manifest is invalid.');
    }
    if (compareVersions(version, activeVersion) <= 0) return false;

    const data = await downloadRuntime(assetUrl, hash);
    fs.mkdirSync(RUNTIME_DIR(), { recursive: true, mode: 0o700 });

    const filename = 'engine-' + version + '.cjs';
    const destination = path.join(RUNTIME_DIR(), filename);
    if (fs.existsSync(destination) && sha256(fs.readFileSync(destination)) !== hash.toLowerCase()) {
      fs.unlinkSync(destination);
    }
    if (!fs.existsSync(destination)) {
      const temporary = destination + '.download';
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, destination);
    }

    const metadata = {
      version,
      filename,
      sha256: hash.toLowerCase(),
      downloadedAt: new Date().toISOString()
    };
    const metaTemporary = ACTIVE_META() + '.tmp';
    fs.writeFileSync(metaTemporary, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    fs.renameSync(metaTemporary, ACTIVE_META());

    const runtimeFiles = fs.readdirSync(RUNTIME_DIR())
      .filter(name => /^engine-\d+\.\d+\.\d+\.cjs$/.test(name))
      .sort((left, right) => compareVersions(right.slice(7, -4), left.slice(7, -4)));
    for (const staleFile of runtimeFiles.slice(2)) {
      try { fs.unlinkSync(path.join(RUNTIME_DIR(), staleFile)); } catch (_) {}
    }

    console.log('Verified DENVique runtime update staged:', version);
    if (activeRuntime && typeof activeRuntime.notifyRuntimeUpdateReady === 'function') {
      activeRuntime.notifyRuntimeUpdateReady(version);
    }
    return true;
  } catch (error) {
    console.warn('DENVique runtime update check skipped:', String(error && error.message || error).slice(0, 300));
    return false;
  } finally {
    checkInProgress = false;
  }
}

loadEngine();

if (app.isPackaged) {
  const firstCheck = setTimeout(() => checkAndStageRuntimeUpdate(), 20000);
  if (firstCheck.unref) firstCheck.unref();
  const updateTimer = setInterval(() => checkAndStageRuntimeUpdate(), CHECK_INTERVAL_MS);
  if (updateTimer.unref) updateTimer.unref();
}
