// Compiles the native helper with the C# compiler built into Windows (.NET Framework 4.x).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
].find(fs.existsSync);
if (!csc) {
  console.error('csc.exe (.NET Framework 4.x) not found');
  process.exit(1);
}

const srcDir = path.join(root, 'helper', 'src');
const dictDir = path.join(root, 'helper', 'dict');
const outDir = path.join(root, 'helper', 'bin');
const out = path.join(outDir, 'SmartSwitcherHelper.exe');
const sources = fs.readdirSync(srcDir).filter(f => f.endsWith('.cs')).map(f => path.join(srcDir, f));
const inputs = [...sources, path.join(dictDir, 'en.txt'), path.join(dictDir, 'ru.txt')];

// Skip the build if the exe is newer than all sources
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  const built = fs.statSync(out).mtimeMs;
  if (inputs.every(f => fs.statSync(f).mtimeMs < built)) {
    console.log('helper: up to date');
    process.exit(0);
  }
}

fs.mkdirSync(outDir, { recursive: true });
const args = [
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/codepage:65001',
  `/out:${out}`,
  '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  `/resource:${path.join(dictDir, 'en.txt')},en.txt`,
  `/resource:${path.join(dictDir, 'ru.txt')},ru.txt`,
  ...sources,
];
try {
  execFileSync(csc, args, { stdio: 'inherit' });
  console.log('helper: built ->', path.relative(root, out));
} catch (e) {
  console.error('helper: compilation failed');
  process.exit(1);
}
