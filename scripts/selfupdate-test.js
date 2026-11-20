// Unit tests for src/selfupdate.js (plain Node, no Electron). Run: npm run test:update
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const su = require('../src/selfupdate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-update-test-'));
const w = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const r = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const SHA = 'a'.repeat(64);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// asset choice
test('chooseAsset picks the win zip and its digest', () => {
  const rel = { assets: [{ name: 'notes.txt' }, { name: 'SmartSwitcher-win-x64.zip', browser_download_url: 'https://x/a.zip', size: 10, digest: 'sha256:' + SHA }] };
  const a = su.chooseAsset(rel, 'win32');
  assert.deepStrictEqual([a.name, a.url, a.size, a.sha256], ['SmartSwitcher-win-x64.zip', 'https://x/a.zip', 10, SHA]);
});
test('chooseAsset: Linux suffix', () => {
  const rel = { assets: [{ name: 'App-linux-x64.tar.gz', browser_download_url: 'https://x/a', size: 1, digest: 'sha256:' + SHA }] };
  assert.strictEqual(su.chooseAsset(rel, 'linux').name, 'App-linux-x64.tar.gz');
});
test('chooseAsset: no asset / no digest', () => {
  assert.throws(() => su.chooseAsset({ assets: [] }, 'win32'), e => e.code === 'NoAsset');
  assert.throws(() => su.chooseAsset({ assets: [{ name: 'a-win-x64.zip', browser_download_url: 'https://x' }] }, 'win32'), e => e.code === 'NoDigest');
  assert.throws(() => su.chooseAsset({ assets: [{ name: 'a-win-x64.zip', browser_download_url: 'https://x', digest: 'sha256:zz' }] }, 'win32'), e => e.code === 'NoDigest');
});
test('env override name and url policy', () => {
  assert.strictEqual(su.envName('smart-switcher'), 'SMART_SWITCHER_UPDATE_API');
  assert.ok(su.downloadUrlAllowed('https://github.com/a', false));
  assert.ok(!su.downloadUrlAllowed('http://127.0.0.1:1/a', false));
  assert.ok(su.downloadUrlAllowed('http://127.0.0.1:1/a', true));
  assert.ok(!su.downloadUrlAllowed('http://evil.example/a', true));
});

// launcher vs self
test('chooseMode: launcher wins, then writable, then page', () => {
  const d = tmp();
  assert.strictEqual(su.chooseMode('C:/NIMVORO.exe', d), 'launcher');
  assert.strictEqual(su.chooseMode(null, d), 'self');
  assert.strictEqual(su.chooseMode(null, path.join(d, 'missing', 'dir')), 'page');
  assert.ok(!fs.existsSync(path.join(d, '.nimvoro-write-test')));
});

// swap, protected files, rollback, cleanup
test('swap replaces files, keeps protected and foreign files', () => {
  const app = tmp(), st = tmp();
  w(app, 'App.exe', 'old'); w(app, 'resources/app.asar', 'old'); w(app, '.nimvoro.json', '{"language":"ru"}'); w(app, 'config.json', 'mine'); w(app, 'extra.txt', 'keep');
  w(st, 'App.exe', 'new'); w(st, 'resources/app.asar', 'new'); w(st, 'resources/helper/h.exe', 'new'); w(st, '.nimvoro.json', '{"language":"en"}'); w(st, 'config.json', 'pkg');
  su.swap(st, app);
  assert.strictEqual(r(app, 'App.exe'), 'new');
  assert.strictEqual(r(app, 'resources/app.asar'), 'new');
  assert.strictEqual(r(app, 'resources/helper/h.exe'), 'new');
  assert.strictEqual(r(app, '.nimvoro.json'), '{"language":"ru"}');
  assert.strictEqual(r(app, 'config.json'), 'mine');
  assert.strictEqual(r(app, 'extra.txt'), 'keep');
  assert.strictEqual(r(app, 'App.exe.old'), 'old');
});
test('swap rolls back when a step fails', () => {
  const app = tmp(), st = tmp();
  w(app, 'a.txt', 'old-a'); w(app, 'b.txt', 'old-b');
  w(st, 'a.txt', 'new-a'); w(st, 'b.txt', 'new-b'); w(st, 'c/d.txt', 'new-d');
  w(app, 'c', 'a file where a folder is needed'); // c/d.txt cannot be created
  assert.throws(() => su.swap(st, app), e => e.code === 'SwapFailed');
  assert.strictEqual(r(app, 'a.txt'), 'old-a');
  assert.strictEqual(r(app, 'b.txt'), 'old-b');
  assert.ok(!fs.existsSync(path.join(app, 'a.txt.old')) && !fs.existsSync(path.join(app, 'b.txt.old')));
});
test('listFiles rejects links', () => {
  const st = tmp(); w(st, 'real.txt', 'x');
  try { fs.symlinkSync(path.join(st, 'real.txt'), path.join(st, 'link.txt')); } catch { return; } // no symlink right: skip
  assert.throws(() => su.listFiles(st), e => e.code === 'BadPackage');
});
test('cleanup removes *.old, staging and leaves the rest', () => {
  const app = tmp();
  w(app, 'a.exe.old', 'x'); w(app, 'resources/b.dll.old', 'x'); w(app, 'resources/deep/c.old', 'keep'); w(app, 'keep.exe', 'x'); w(app, '.update-staging/f', 'x');
  su.cleanup(app, 'ss-test-none');
  assert.ok(!fs.existsSync(path.join(app, 'a.exe.old')));
  assert.ok(!fs.existsSync(path.join(app, 'resources/b.dll.old')));
  assert.ok(fs.existsSync(path.join(app, 'resources/deep/c.old'))); // only one level deep
  assert.ok(fs.existsSync(path.join(app, 'keep.exe')));
  assert.ok(!fs.existsSync(path.join(app, '.update-staging')));
});

// helper: waits for the PID, swaps, relaunches (node itself plays the app exe)
test('helper script swaps after the app pid is gone', () => {
  const { spawnSync } = require('child_process');
  const app = tmp(), st = path.join(app, '.update-staging');
  w(app, 'resources/app.asar', 'old'); w(app, '.nimvoro.json', 'keep'); w(st, 'resources/app.asar', 'new');
  const job = { pid: 2147483000, staging: st, appDir: app, exe: process.execPath, args: ['-e', ''], id: 'ss-helper-test' };
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'selfupdate-helper.js'), JSON.stringify(job)], { timeout: 20000 });
  assert.strictEqual(res.status, 0, String(res.stderr));
  assert.strictEqual(r(app, 'resources/app.asar'), 'new');
  assert.strictEqual(r(app, 'resources/app.asar.old'), 'old');
  assert.strictEqual(r(app, '.nimvoro.json'), 'keep');
  assert.ok(!fs.existsSync(st));
});

// digest, end to end through download/extract with a local file server
(async () => {
  const http = require('http');
  const { execFileSync } = require('child_process');
  const src = tmp(), zip = path.join(tmp(), 'Fake-win-x64.zip');
  w(src, 'App.exe', 'new exe'); w(src, 'resources/app.asar', 'new asar');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', src, '.'], { windowsHide: true });
  const good = await su.sha256File(zip);
  const server = http.createServer((q, s) => { s.end(fs.readFileSync(zip)); }).listen(0, '127.0.0.1');
  await new Promise(res => server.on('listening', res));
  const url = `http://127.0.0.1:${server.address().port}/Fake-win-x64.zip`;
  const size = fs.statSync(zip).size;
  const mk = digest => ({ assets: [{ name: 'Fake-win-x64.zip', browser_download_url: url, size, digest: 'sha256:' + digest }] });
  const app = tmp(); w(app, 'App.exe', 'old exe'); w(app, 'resources/app.asar', 'old asar');
  const phases = [];
  try {
    // bad digest: nothing installed
    await assert.rejects(su.run({ release: mk(SHA), id: 'ss-test', appDir: app, exePath: path.join(app, 'App.exe'), overridden: true, onPhase: p => phases.push(p.phase) }), e => e.code === 'BadDigest');
    assert.strictEqual(r(app, 'App.exe'), 'old exe');
    console.log('ok  bad digest installs nothing'); n++;
    // plain http without the override is refused
    await assert.rejects(su.run({ release: mk(good), id: 'ss-test', appDir: app, exePath: path.join(app, 'App.exe'), overridden: false }), e => e.code === 'NoAsset');
    console.log('ok  http is refused without the override'); n++;
    // package without the running exe name
    await assert.rejects(su.run({ release: mk(good), id: 'ss-test', appDir: app, exePath: path.join(app, 'Other.exe'), overridden: true }), e => e.code === 'BadPackage');
    assert.ok(!fs.existsSync(path.join(app, su.STAGING)));
    console.log('ok  wrong package is rejected, staging removed'); n++;
    // good digest: swapped, relaunch of node itself as the "exe" so we can see the env var
    const marker = path.join(app, 'relaunched.txt');
    const fakeExe = process.execPath;
    let restarted = false;
    fs.copyFileSync(zip, path.join(tmp(), 'x'));
    // stage a package that contains the node binary name, so BadPackage does not fire
    const nodeName = path.basename(fakeExe);
    const src2 = tmp(); w(src2, nodeName, 'x'); w(src2, 'resources/app.asar', 'new asar');
    const zip2 = path.join(tmp(), 'Fake2-win-x64.zip');
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip2, '-C', src2, '.'], { windowsHide: true });
    server.close();
    const server2 = http.createServer((q, s) => s.end(fs.readFileSync(zip2))).listen(0, '127.0.0.1');
    await new Promise(res => server2.on('listening', res));
    const rel2 = { assets: [{ name: 'Fake2-win-x64.zip', browser_download_url: `http://127.0.0.1:${server2.address().port}/z`, size: fs.statSync(zip2).size, digest: 'sha256:' + await su.sha256File(zip2) }] };
    const app2 = tmp(); w(app2, nodeName, 'old'); w(app2, 'resources/app.asar', 'old asar'); w(app2, '.nimvoro.json', '{"language":"uk"}');
   
    // the staged dummy is not a real exe, so the relaunch fails after a good swap: reported as Restart
    await assert.rejects(su.run({ release: rel2, id: 'ss-test', appDir: app2, exePath: path.join(app2, nodeName), overridden: true, restart: () => { restarted = true; }, onPhase: p => phases.push(p.phase) }), e => e.code === 'Restart');
    assert.strictEqual(r(app2, 'resources/app.asar'), 'new asar');
    assert.strictEqual(r(app2, 'resources/app.asar.old'), 'old asar');
    assert.strictEqual(r(app2, '.nimvoro.json'), '{"language":"uk"}');
    assert.ok(!fs.existsSync(path.join(app2, su.STAGING)));
    assert.ok(!restarted);
    assert.deepStrictEqual([...new Set(phases)].filter(x => x !== 'failed'), ['downloading', 'verifying', 'installing', 'restarting']);
    console.log('ok  good digest: extract, swap, restart, marker kept'); n++;
    server2.close();
  } finally { server.close(); }
  console.log(`\n${n} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
