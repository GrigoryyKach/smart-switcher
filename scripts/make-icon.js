// Запускается под Electron: рисует иконку приложения и сохраняет её как build/icon.ico.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { renderIcons } = require('../src/icons');

app.whenReady().then(async () => {
  const icons = await renderIcons();
  const sizes = [256, 64, 32];
  const pngs = sizes.map(s => icons.app.toPNG({ scaleFactor: s / 32 }));

  // ICO с PNG-кадрами: заголовок, каталог, затем данные
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  const out = path.join(__dirname, '..', 'build', 'icon.ico');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...pngs]));
  console.log('icon →', out);
  app.quit();
});
