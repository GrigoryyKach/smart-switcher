// Runs detached after the app has exited (ELECTRON_RUN_AS_NODE, copied to a temp folder): waits for the app's PID,
// swaps the staged files into the app folder (files that were locked while the app ran are free now),
// then starts the app again. On failure the swap is rolled back and the old version is started.
process.noAsar = true; // app.asar is a plain file here
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const su = require('./selfupdate');

const job = JSON.parse(process.argv[2]);
const log = msg => { try { fs.appendFileSync(path.join(os.tmpdir(), `${job.id}-update`, 'helper.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } };

(async () => {
  const end = Date.now() + 30000;
  while (su.pidAlive(job.pid) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300)); // let the OS release the handles
  try { log(`swapped ${su.swap(job.staging, job.appDir)} files`); } catch (e) { log(`swap failed, rolled back: ${e.message}`); }
  try { fs.rmSync(job.staging, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    spawn(job.exe, job.args || [], { cwd: job.appDir, detached: true, stdio: 'ignore', env }).unref();
    log('relaunched');
  } catch (e) { log(`relaunch failed: ${e.message}`); }
  process.exit(0);
})();
