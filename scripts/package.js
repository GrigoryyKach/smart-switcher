// Собирает готовую к запуску папку dist/SmartSwitcher-win32-x64 с SmartSwitcher.exe внутри.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });

(async () => {
  run('node', ['scripts/build-helper.js']);

  // хелпер кладём в build/helper → в собранном приложении он окажется в resources/helper
  const stage = path.join(root, 'build', 'helper');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(path.join(root, 'helper', 'bin', 'SmartSwitcherHelper.exe'), path.join(stage, 'SmartSwitcherHelper.exe'));

  run('npx', ['electron', 'scripts/make-icon.js']);

  const [out] = await packager({
    dir: root,
    name: 'SmartSwitcher',
    executableName: 'SmartSwitcher',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    icon: path.join(root, 'build', 'icon.ico'),
    extraResource: [stage],
    ignore: [/^\/(helper|scripts|build|dist|\.claude)(\/|$)/, /^\/README\.md$/],
    win32metadata: {
      ProductName: 'Smart Switcher',
      FileDescription: 'Smart Switcher',
      CompanyName: 'local',
    },
  });
  console.log('\nГотово:', path.join(out, 'SmartSwitcher.exe'));
})().catch(e => {
  console.error(e);
  process.exit(1);
});
