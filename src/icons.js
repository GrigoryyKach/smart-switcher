// Tray state icons (layout indicators) are drawn on a canvas in a hidden window.
// The application icon itself comes from assets/icon.png.
const path = require('path');
const { BrowserWindow, nativeImage } = require('electron');

function draw() {
  const rr = (g, x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  const variants = {
    en: { text: 'EN', color: '#5b78ff' },
    ru: { text: 'RU', color: '#ec5b45' },
    other: { text: '••', color: '#9a9aa0' },
  };
  const out = {};
  for (const [key, v] of Object.entries(variants)) {
    for (const off of [false, true]) {
      const name = key + (off ? '-off' : '');
      out[name] = {};
      for (const s of [16, 24, 32, 48]) {
        const c = document.createElement('canvas');
        c.width = c.height = s;
        const g = c.getContext('2d');
        // Flat tile of the suite icons: solid graphite, no gradient; the layout code is drawn in the accent.
        g.fillStyle = '#19191b';
        rr(g, 0, 0, s, s, s * 0.22);
        g.fill();
        g.fillStyle = off ? '#6b6b72' : v.color;
        g.font = `800 ${Math.round(s * (v.text.length > 1 && key !== 'other' ? 0.5 : 0.42))}px "Segoe UI", Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(v.text, s / 2, s / 2 + s * 0.04);
        if (off) {
          g.strokeStyle = '#ededed';
          g.lineWidth = Math.max(1.2, s / 14);
          g.beginPath();
          g.moveTo(s * 0.2, s * 0.8);
          g.lineTo(s * 0.8, s * 0.2);
          g.stroke();
        }
        out[name][s] = c.toDataURL('image/png');
      }
    }
  }
  return out;
}

async function renderIcons() {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true } });
  await win.loadURL('about:blank');
  const data = await win.webContents.executeJavaScript(`(${draw.toString()})()`);
  win.destroy();

  const icons = {};
  for (const [name, sizes] of Object.entries(data)) {
    const base = 16;
    const img = nativeImage.createEmpty();
    for (const [size, url] of Object.entries(sizes)) {
      img.addRepresentation({ scaleFactor: Number(size) / base, dataURL: url });
    }
    icons[name] = img;
  }
  icons.app = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  return icons;
}

module.exports = { renderIcons };
