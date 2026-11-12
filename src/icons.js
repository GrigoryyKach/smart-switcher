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
    en: { text: 'EN', from: '#4f8cff', to: '#2a5fd8' },
    ru: { text: 'RU', from: '#ff6a55', to: '#d63c2e' },
    other: { text: '••', from: '#8b93a1', to: '#5f6673' },
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
        const grad = g.createLinearGradient(0, 0, 0, s);
        grad.addColorStop(0, off ? '#9aa1ad' : v.from);
        grad.addColorStop(1, off ? '#6b7280' : v.to);
        g.fillStyle = grad;
        rr(g, 0.5, 0.5, s - 1, s - 1, s * 0.24);
        g.fill();
        g.fillStyle = off ? 'rgba(255,255,255,0.75)' : '#fff';
        g.font = `800 ${Math.round(s * (v.text.length > 1 && key !== 'other' ? 0.5 : 0.42))}px "Segoe UI", Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(v.text, s / 2, s / 2 + s * 0.04);
        if (off) {
          g.strokeStyle = 'rgba(255,255,255,0.9)';
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
