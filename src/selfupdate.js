// NIMVORO self-update for a standalone install (no launcher). Same design as the Rust apps:
// tasks/selfupdate-design.md. No Electron imports here, so the whole thing is unit-testable with plain Node.
//
// Flow: download (curl) -> verify SHA-256 -> extract (tar) to <app dir>\.update-staging
//       -> journalled swap (*.old backups, rollback on failure) -> relaunch with NIMVORO_WAIT_PID.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const STAGING = '.update-staging';
const WRITE_TEST = '.nimvoro-write-test';
// Never replaced, even if the package contains them: the language marker and portable data.
const PROTECTED = new Set(['.nimvoro.json', 'library.json', 'config.json', 'settings.json']);
const WAIT_PID_ENV = 'NIMVORO_WAIT_PID';

class UpdateError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code; // NoAsset | NoDigest | Download | BadDigest | Extract | BadPackage | SwapFailed | Restart
  }
}

const platformSuffix = (platform = process.platform) => (platform === 'win32' ? '-win-x64.zip' : '-linux-x64.tar.gz');

/** The asset of the release for this platform, or throws NoAsset / NoDigest. */
function chooseAsset(release, platform = process.platform) {
  const suffix = platformSuffix(platform);
  const a = (release && Array.isArray(release.assets) ? release.assets : []).find(x => x && typeof x.name === 'string' && x.name.endsWith(suffix));
  if (!a || !a.browser_download_url) throw new UpdateError('NoAsset');
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
  if (!m) throw new UpdateError('NoDigest');
  return { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0, sha256: m[1].toLowerCase() };
}

/** Test override: <ID>_UPDATE_API replaces the whole release URL and lets the download be plain http://127.0.0.1. */
const envName = id => `${id.toUpperCase().replace(/-/g, '_')}_UPDATE_API`;

function downloadUrlAllowed(url, overridden) {
  if (/^https:\/\//i.test(url)) return true;
  return overridden && /^http:\/\/127\.0\.0\.1[:/]/i.test(url);
}

/** 'launcher' | 'self' | 'page' */
function chooseMode(launcherExe, appDir) {
  if (launcherExe) return 'launcher';
  return isWritable(appDir) ? 'self' : 'page';
}

function isWritable(dir) {
  const probe = path.join(dir, WRITE_TEST);
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; } catch { return false; }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Plain recursive list of regular files; throws BadPackage on links or anything odd. */
function listFiles(root, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const r = rel ? path.join(rel, name) : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink()) throw new UpdateError('BadPackage', 'link ' + r);
    if (st.isDirectory()) out.push(...listFiles(root, r));
    else if (st.isFile()) out.push(r);
    else throw new UpdateError('BadPackage', 'entry ' + r);
  }
  return out;
}

function move(src, dest) {
  try { fs.renameSync(src, dest); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    const mode = fs.statSync(src).mode;
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, mode);
    fs.unlinkSync(src);
  }
}

/** Journalled swap of every staged file into appDir. Rolls back on failure and throws SwapFailed. */
function swap(stagingDir, appDir) {
  const files = listFiles(stagingDir).filter(r => !PROTECTED.has(path.basename(r)));
  const journal = []; // { dest, backedUp }
  const rollback = () => {
    for (const j of journal.reverse()) {
      try { fs.rmSync(j.dest, { force: true }); } catch { /* best effort */ }
      if (j.backedUp) { try { fs.renameSync(j.dest + '.old', j.dest); } catch { /* best effort */ } }
    }
  };
  try {
    for (const rel of files) {
      const dest = path.join(appDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const entry = { dest, backedUp: false };
      if (fs.existsSync(dest)) {
        fs.rmSync(dest + '.old', { force: true }); // a running exe can be renamed but not deleted
        fs.renameSync(dest, dest + '.old');
        entry.backedUp = true;
      }
      journal.push(entry);
      move(path.join(stagingDir, rel), dest);
    }
  } catch (e) {
    rollback();
    const err = new UpdateError('SwapFailed', e.message);
    err.locked = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code); // files in use: a helper can swap after we exit
    throw err;
  }
  return journal.length;
}

/** Deletes leftovers of the previous update: *.old (top level and one folder deep), staging, temp download. */
function cleanup(appDir, id) {
  const rmOld = dir => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.old')) { try { fs.rmSync(p, { force: true }); } catch { /* still running */ } }
      else if (e.isDirectory() && dir === appDir) rmOld(p);
    }
  };
  rmOld(appDir);
  try { fs.rmSync(path.join(appDir, STAGING), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(os.tmpdir(), `${id}-update`), { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Copies selfupdate.js + selfupdate-helper.js to a temp folder and starts the helper detached through
 * ELECTRON_RUN_AS_NODE (the app's own exe, so no extra runtime). Call it with asar support ON, it reads from app.asar.
 */
function spawnHelper(job, runtimeExe = process.execPath) {
  const dir = path.join(os.tmpdir(), `${job.id}-update`, 'helper');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['selfupdate.js', 'selfupdate-helper.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  const child = spawn(runtimeExe, [path.join(dir, 'selfupdate-helper.js'), JSON.stringify(job)], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Call at the very top of the main process, before the single-instance lock:
 * waits (max 15 s) for the PID that started us, then cleans up after the previous update.
 */
function startup(appDir, id) {
  const pid = parseInt(process.env[WAIT_PID_ENV] || '', 10);
  delete process.env[WAIT_PID_ENV];
  if (pid > 0 && pid !== process.pid) {
    const end = Date.now() + 15000;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (pidAlive(pid) && Date.now() < end) Atomics.wait(cell, 0, 0, 100);
  }
  cleanup(appDir, id);
}

function download(url, file, size, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { force: true });
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = spawn(curl, ['-fsSL', '--max-time', '900', '-A', 'NIMVORO-updater', '-o', file, url], { windowsHide: true, stdio: 'ignore' });
    const timer = setInterval(() => {
      try { onProgress(Math.min(fs.statSync(file).size, size || Infinity), size); } catch { /* not created yet */ }
    }, 100);
    child.on('error', e => { clearInterval(timer); reject(new UpdateError('Download', e.message)); });
    child.on('exit', code => {
      clearInterval(timer);
      if (code === 0) { onProgress(size, size); resolve(); } else reject(new UpdateError('Download', 'curl exit ' + code));
    });
  });
}

function extract(archive, staging) {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const args = process.platform === 'win32' ? ['-xf', archive, '-C', staging] : ['-xzf', archive, '-C', staging];
  const r = spawnSync(tar, args, { windowsHide: true });
  if (r.status !== 0) throw new UpdateError('Extract', String(r.stderr || r.error || ''));
}

/**
 * Runs the whole update. opts: { release, id, appDir, exePath, args, overridden, beforeSwap, onPhase, restart }.
 * onPhase({ phase, done, total, error }) phases: downloading | verifying | installing | restarting | failed.
 * restart() is called after the new exe has been spawned (the host quits there).
 */
async function run(opts) {
  const { release, id, appDir, exePath, args = [], overridden = false, onPhase = () => {} } = opts;
  const staging = path.join(appDir, STAGING);
  try {
    const asset = chooseAsset(release);
    if (!downloadUrlAllowed(asset.url, overridden)) throw new UpdateError('NoAsset', 'insecure url');
    const file = path.join(os.tmpdir(), `${id}-update`, asset.name);
    onPhase({ phase: 'downloading', done: 0, total: asset.size });
    await download(asset.url, file, asset.size, (done, total) => onPhase({ phase: 'downloading', done, total }));

    onPhase({ phase: 'verifying' });
    if ((await sha256File(file)) !== asset.sha256) { fs.rmSync(file, { force: true }); throw new UpdateError('BadDigest'); }

    onPhase({ phase: 'installing' });
    extract(file, staging);
    listFiles(staging); // rejects links
    if (!fs.existsSync(path.join(staging, path.basename(exePath)))) throw new UpdateError('BadPackage', 'no ' + path.basename(exePath));
    if (opts.beforeSwap) opts.beforeSwap();
    let deferred = false;
    try {
      try { swap(staging, appDir); } finally { if (opts.afterSwap) opts.afterSwap(); }
    } catch (e) {
      // Files in use (Electron keeps app.asar open): the swap was rolled back, so let a helper do it once we have exited.
      if (e.code === 'SwapFailed' && e.locked && opts.helperRunner) deferred = true; else throw e;
    }

    onPhase({ phase: 'restarting' });
    if (deferred) {
      try { opts.helperRunner({ pid: process.pid, staging, appDir, exe: exePath, args, id }); } catch (e) { throw new UpdateError('SwapFailed', e.message); }
    } else {
      fs.rmSync(staging, { recursive: true, force: true });
      await new Promise((resolve, reject) => {
        let child;
        try { child = spawn(exePath, args, { cwd: appDir, detached: true, stdio: 'ignore', env: { ...process.env, [WAIT_PID_ENV]: String(process.pid) } }); }
        catch (e) { reject(new UpdateError('Restart', e.message)); return; }
        child.once('error', e => reject(new UpdateError('Restart', e.message)));
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    }
    if (opts.restart) opts.restart();
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    const err = e instanceof UpdateError ? e : new UpdateError('Download', e.message);
    onPhase({ phase: 'failed', error: err.code, detail: err.message });
    throw err;
  }
}

module.exports = {
  UpdateError, STAGING, PROTECTED, WAIT_PID_ENV,
  chooseAsset, chooseMode, downloadUrlAllowed, envName, isWritable, sha256File, listFiles,
  swap, cleanup, startup, extract, download, run, spawnHelper, pidAlive,
};
