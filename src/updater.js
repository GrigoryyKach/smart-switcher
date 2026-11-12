// NIMVORO: update check through GitHub Releases and hand-off of the update to the launcher.
// The contract is described in nimvoro/docs/ADDING_A_TOOL.md.
const { app, net, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ID = 'smart-switcher';
const REPO = 'GrigoryyKach/smart-switcher';

// idle | checking | latest | available | failed
let state = { status: 'idle', current: app.getVersion(), version: null, url: null };

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
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'NIMVORO-updater', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
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
    const file = path.join(app.getPath('appData'), 'NIMVORO', 'launcher.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).path;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** True if the update was handed to the launcher and the app should quit. */
function apply() {
  const exe = launcherPath();
  if (exe) {
    try {
      spawn(exe, ['--update', ID], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch { /* open the release page instead */ }
  }
  shell.openExternal(state.url || `https://github.com/${REPO}/releases/latest`);
  return false;
}

module.exports = { check, apply, isNewer, getState: () => state };
