const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const { renderIcons } = require('./icons');
const updater = require('./updater');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const APP_NAME = 'Smart Switcher';
app.setName(APP_NAME);
app.setAppUserModelId('local.smart-switcher');

// ───────────────────────── конфигурация ─────────────────────────

const DEFAULTS = {
  enabled: true,
  autoSwitch: true,
  sound: true,
  autostart: false,
  checkUpdates: true,
  triggerSpace: true,
  triggerEnter: true,
  triggerTab: false,
  sensitivity: 6,
  minWordLength: 1,
  retro: true,
  learnOnUndo: true,
  hotkey: 'Pause',
  selectionHotkey: 'Shift+Pause',
  exceptions: [],
  excludedApps: [],
  stats: { converted: 0, undone: 0, manual: 0 },
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = { ...DEFAULTS };
let saveTimer = null;

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = { ...DEFAULTS, ...raw, stats: { ...DEFAULTS.stats, ...(raw.stats || {}) } };
  } catch {
    config = { ...DEFAULTS };
  }
}

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      console.error('config save failed', e);
    }
  }, 200);
}

function applyAutostart() {
  const opts = { openAtLogin: !!config.autostart };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [path.resolve(__dirname, '..')];
  }
  try { app.setLoginItemSettings(opts); } catch (e) { console.error(e); }
}

// ───────────────────────── нативный хелпер ─────────────────────────

const helperPath = app.isPackaged
  ? path.join(process.resourcesPath, 'helper', 'SmartSwitcherHelper.exe')
  : path.join(__dirname, '..', 'helper', 'bin', 'SmartSwitcherHelper.exe');

let helper = null;
let quitting = false;
let restarts = 0;
let reqId = 0;
const pending = new Map();

const status = {
  running: false,
  lang: 'other',
  layouts: { en: true, ru: true },
  dict: null,
  error: null,
};
const log = [];

function startHelper() {
  if (!fs.existsSync(helperPath)) {
    status.error = 'Не найден SmartSwitcherHelper.exe — выполните npm run build:helper';
    broadcast({ type: 'status', status });
    return;
  }
  helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  helper.stdout.setEncoding('utf8');
  helper.stdin.on('error', () => {});
  readline.createInterface({ input: helper.stdout }).on('line', onHelperLine);
  helper.stderr.on('data', d => console.error('[helper]', d.toString()));
  helper.on('exit', code => {
    helper = null;
    status.running = false;
    updateTray();
    broadcast({ type: 'status', status });
    if (quitting) return;
    if (code === 2) {
      status.error = 'Уже запущен другой экземпляр хелпера';
      return;
    }
    restarts++;
    setTimeout(startHelper, Math.min(15000, 500 * restarts));
  });
  sendConfig();
}

function send(obj) {
  if (helper && helper.stdin.writable) helper.stdin.write(JSON.stringify(obj) + '\n');
}

function request(type, payload = {}) {
  return new Promise(resolve => {
    if (!helper) return resolve(null);
    const id = ++reqId;
    pending.set(id, resolve);
    send({ type, id, ...payload });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve(null); }
    }, 3000);
  });
}

function sendConfig() {
  const { stats, autostart, learnOnUndo, checkUpdates, ...forHelper } = config;
  send({ type: 'config', ...forHelper });
}

function onHelperLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  switch (msg.type) {
    case 'ready':
      restarts = 0;
      status.running = true;
      status.error = null;
      status.layouts = msg.layouts;
      status.dict = msg.dict;
      updateTray();
      broadcast({ type: 'status', status });
      break;
    case 'layout':
      status.lang = msg.lang;
      updateTray();
      broadcast({ type: 'status', status });
      break;
    case 'converted':
      onConverted(msg);
      break;
    case 'error':
      console.error('[helper error]', msg.message);
      break;
  }
}

function onConverted(msg) {
  const entry = {
    time: Date.now(),
    kind: msg.kind,
    from: msg.from,
    to: msg.to,
    word: msg.word || null,
    app: msg.app || '',
  };
  log.unshift(entry);
  if (log.length > 200) log.length = 200;

  if (msg.kind === 'auto') config.stats.converted++;
  else if (msg.kind === 'undo') config.stats.undone++;
  else config.stats.manual++;

  if (msg.kind === 'undo' && msg.word && config.learnOnUndo) {
    const w = msg.word.toLowerCase();
    if (!config.exceptions.includes(w)) {
      config.exceptions.push(w);
      entry.learned = w;
      sendConfig();
    }
  }
  saveConfig();
  broadcast({ type: 'converted', entry, config });
}

// ───────────────────────── трей ─────────────────────────

let tray = null;
let icons = null;

function trayImage() {
  const key = (['en', 'ru'].includes(status.lang) ? status.lang : 'other') + (config.enabled && status.running ? '' : '-off');
  return icons[key];
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayImage());
  const langName = { en: 'English', ru: 'Русский' }[status.lang] || 'другая раскладка';
  const state = !status.running ? 'хелпер не запущен' : config.enabled ? 'включено' : 'на паузе';
  tray.setToolTip(`${APP_NAME} — ${langName}, ${state}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    {
      label: 'Автопереключение',
      type: 'checkbox',
      checked: config.enabled,
      click: item => setConfig({ enabled: item.checked }),
    },
    {
      label: 'Звук',
      type: 'checkbox',
      checked: config.sound,
      click: item => setConfig({ sound: item.checked }),
    },
    { type: 'separator' },
    { label: 'Настройки…', click: () => openSettings() },
    { label: 'Журнал исправлений', click: () => openSettings('log') },
    ...(updater.getState().status === 'available'
      ? [{ label: `Обновить до версии ${updater.getState().version}`, click: () => { if (updater.apply()) { quitting = true; app.quit(); } } }]
      : []),
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ───────────────────────── окно настроек ─────────────────────────

let settingsWin = null;

function openSettings(page) {
  if (settingsWin) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    if (page) settingsWin.webContents.send('event', { type: 'navigate', page });
    return;
  }
  settingsWin = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 780,
    minHeight: 540,
    show: false,
    title: APP_NAME,
    icon: icons && icons.app,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161b' : '#f4f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'), { query: page ? { page } : {} });
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    if (process.env.SS_CAPTURE_DIR) captureAllPages(process.env.SS_CAPTURE_DIR);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// Для разработки: SS_CAPTURE_DIR=<папка> — снять скриншоты всех страниц настроек и выйти.
async function captureAllPages(dir) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  await wait(1500);
  for (const page of ['general', 'detection', 'hotkeys', 'exceptions', 'apps', 'log', 'about']) {
    settingsWin.webContents.send('event', { type: 'navigate', page });
    if (page === 'detection') {
      await settingsWin.webContents.executeJavaScript(
        "document.querySelector('#testInput').value='ghbdtn'; document.querySelector('#testInput').dispatchEvent(new Event('input'));");
    }
    await wait(700);
    const img = await settingsWin.webContents.capturePage();
    fs.writeFileSync(path.join(dir, page + '.png'), img.toPNG());
  }
  quitting = true;
  app.quit();
}

function broadcast(msg) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('event', msg);
}

function setConfig(patch) {
  const allowed = Object.keys(DEFAULTS).filter(k => k !== 'stats');
  for (const k of Object.keys(patch)) if (allowed.includes(k)) config[k] = patch[k];
  if (Array.isArray(config.exceptions)) {
    config.exceptions = [...new Set(config.exceptions.map(w => String(w).trim().toLowerCase()).filter(Boolean))];
  }
  if (Array.isArray(config.excludedApps)) {
    config.excludedApps = [...new Set(config.excludedApps.map(a => String(a).trim().replace(/\.exe$/i, '')).filter(Boolean))];
  }
  if ('autostart' in patch) applyAutostart();
  saveConfig();
  sendConfig();
  updateTray();
  broadcast({ type: 'config', config });
  return config;
}

ipcMain.handle('state:get', () => ({ config, status, log, version: app.getVersion(), update: updater.getState() }));
ipcMain.handle('update:check', () => updater.check(onUpdate));
ipcMain.handle('update:apply', () => {
  if (updater.apply()) { quitting = true; app.quit(); }
});
ipcMain.handle('config:set', (_e, patch) => setConfig(patch || {}));
ipcMain.handle('config:reset', () => {
  const { stats, exceptions, excludedApps } = config;
  config = { ...DEFAULTS, stats, exceptions, excludedApps };
  applyAutostart();
  saveConfig();
  sendConfig();
  updateTray();
  return config;
});
ipcMain.handle('stats:reset', () => {
  config.stats = { ...DEFAULTS.stats };
  saveConfig();
  return config;
});
ipcMain.handle('log:clear', () => { log.length = 0; return log; });
ipcMain.handle('apps:list', async () => {
  const r = await request('listApps');
  return r ? r.list : [];
});
ipcMain.handle('analyze', async (_e, text) => request('analyze', { text: String(text || '') }));

// ───────────────────────── обновления (NIMVORO) ─────────────────────────

function onUpdate(u) {
  broadcast({ type: 'update', update: u });
  if (u.status === 'available') {
    updateTray();
    if (tray) tray.displayBalloon?.({ title: 'Smart Switcher', content: `Доступна версия ${u.version}. Откройте настройки → О программе.` });
  }
}

// ───────────────────────── жизненный цикл ─────────────────────────

app.on('second-instance', () => openSettings());
app.on('window-all-closed', () => { /* живём в трее */ });
app.on('before-quit', () => {
  quitting = true;
  send({ type: 'quit' });
  if (helper) setTimeout(() => { try { helper && helper.kill(); } catch {} }, 500);
});

app.whenReady().then(async () => {
  loadConfig();
  icons = await renderIcons();
  tray = new Tray(icons['other']);
  tray.on('click', () => openSettings());
  updateTray();
  startHelper();
  if (config.checkUpdates) updater.check(onUpdate);
  if (!fs.existsSync(configPath()) || process.env.SS_CAPTURE_DIR) {
    saveConfig();
    openSettings(); // первый запуск — показать настройки
  }
});
