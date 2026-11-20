// NIMVORO: update check through GitHub Releases and hand-off of the update to the launcher.
// The contract is described in nimvoro/docs/ADDING_A_TOOL.md.
const { app, net, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const selfupdate = require('./selfupdate');

const ID = 'smart-switcher';
const REPO = 'GrigoryyKach/smart-switcher';

// idle | checking | latest | available | failed | updating
// While updating, `progress` is { phase, done, total, error } (see selfupdate.run).
let state = { status: 'idle', current: app.getVersion(), version: null, url: null, progress: null };
let release = null; // the last release JSON, used by the self-update

const apiOverride = () => process.env[selfupdate.envName(ID)] || '';
const apiUrl = () => apiOverride() || `https://api.github.com/repos/${REPO}/releases/latest`;

function parse(v) {
  return String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parse(candidate), b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function check(onChange) {
  if (state.status === 'checking') return state;
  state = { ...state, status: 'checking' };
  onChange(state);
  try {
    const res = await net.fetch(apiUrl(), {
      headers: { 'User-Agent': 'NIMVORO-updater', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    release = rel;
    const newer = isNewer(rel.tag_name, state.current);
    state = {
      ...state,
      status: newer ? 'available' : 'latest',
      version: String(rel.tag_name || '').replace(/^v/i, ''),
      url: rel.html_url,
    };
  } catch {
    state = { ...state, status: 'failed' };
  }
  onChange(state);
  return state;
}

function launcherPath() {
  try {
    // NIMVORO_LAUNCHER_JSON: test-only override of the launcher pointer
    const file = process.env.NIMVORO_LAUNCHER_JSON || path.join(app.getPath('appData'), 'NIMVORO', 'launcher.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).path;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const appDir = () => path.dirname(process.execPath);

/**
 * Starts the update. Returns:
 *   'launcher' - handed to NIMVORO, the app should quit;
 *   'self'     - downloading and installing here, `hooks.restart` is called when the new exe is running;
 *   'page'     - opened the release page.
 * hooks: { onChange(state), beforeSwap(), restart() }
 */
function apply(hooks = {}) {
  const exe = launcherPath();
  const mode = app.isPackaged ? selfupdate.chooseMode(exe, appDir()) : (exe ? 'launcher' : 'page');
  if (mode === 'launcher') {
    try {
      spawn(exe, ['--update', ID], { detached: true, stdio: 'ignore' }).unref();
      return 'launcher';
    } catch { /* open the release page instead */ }
  } else if (mode === 'self' && state.status !== 'updating') {
    startSelf(hooks);
    return 'self';
  }
  if (mode === 'self') return 'self';
  shell.openExternal(state.url || `https://github.com/${REPO}/releases/latest`);
  return 'page';
}

function startSelf(hooks) {
  const onChange = hooks.onChange || (() => {});
  const set = progress => { state = { ...state, status: progress.phase === 'failed' ? 'failed-update' : 'updating', progress }; onChange(state); };
  state = { ...state, status: 'updating', progress: { phase: 'downloading', done: 0, total: 0 } };
  onChange(state);
  (async () => {
    // fetch the release again so "Try again" works after a failure
    if (!release) {
      try {
        const res = await net.fetch(apiUrl(), { headers: { 'User-Agent': 'NIMVORO-updater', Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        release = await res.json();
      } catch { set({ phase: 'failed', error: 'Download' }); return; }
    }
    try {
      await selfupdate.run({
        release, id: ID, appDir: appDir(), exePath: process.execPath, args: process.argv.slice(1),
        overridden: !!apiOverride(), restart: hooks.restart, onPhase: set,
        // app.asar is a file here, not a folder: turn Electron's asar emulation off while renaming it
        beforeSwap: () => { process.noAsar = true; if (hooks.beforeSwap) hooks.beforeSwap(); },
        afterSwap: () => { process.noAsar = false; },
        helperRunner: job => selfupdate.spawnHelper(job),
      });
    } catch { /* reported through onPhase */ }
  })();
}

function openPage() {
  shell.openExternal(state.url || `https://github.com/${REPO}/releases/latest`);
}

module.exports = { check, apply, openPage, isNewer, getState: () => state, startup: () => selfupdate.startup(appDir(), ID) };
