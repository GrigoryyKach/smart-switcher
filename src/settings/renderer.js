const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let state = { config: {}, status: {}, log: [] };

// ───── line icons: 24 box, 1.5 px stroke that does not scale (vector-effect in styles.css) ─────
const ICONS = {
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
function icon(name) {
  const e = document.createElement('span');
  e.className = 'ico';
  e.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return e;
}

// ───── i18n ─────
const L = () => state.config.language || 'en';
const tr = (key, ...args) => I18N.t(L(), key, ...args);

function applyI18n() {
  document.documentElement.lang = L();
  $$('[data-i18n]').forEach(e => { e.textContent = tr(e.dataset.i18n); });
  $$('[data-i18n-html]').forEach(e => { e.innerHTML = tr(e.dataset.i18nHtml); });
  $$('[data-i18n-ph]').forEach(e => { e.placeholder = tr(e.dataset.i18nPh); });
  for (const sel of ['#excList', '#appList']) $(sel).dataset.empty = tr('listEmpty');
  $('#runningApps').dataset.empty = tr('pressRefresh');
  $('#logList').dataset.empty = tr('logEmpty');
  const sel = $('#langSelect');
  if (!sel.options.length) for (const l of I18N.LANGS) sel.add(new Option(l.name, l.code));
  renderLog();
  renderUpdate(state.update);
  runTest();
}

// ───── navigation ─────
function go(page) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  if (page === 'apps' && !$('#runningApps').children.length) loadRunningApps();
}
$$('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));

// ───── settings binding ─────
async function save(patch) {
  state.config = await window.api.setConfig(patch);
  render();
}

$$('[data-key]').forEach(el => {
  const key = el.dataset.key;
  const evt = el.type === 'range' ? 'input' : 'change';
  el.addEventListener(evt, () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'range' || el.dataset.type === 'number') v = Number(v);
    if (key === 'sensitivity') { $('#sensValue').textContent = v; setFill(el); }
    save({ [key]: v });
    if (key === 'sensitivity') runTest();
  });
});

let appliedLang = null;

function render() {
  const c = state.config;
  if (appliedLang !== L()) { appliedLang = L(); applyI18n(); }
  $$('[data-key]').forEach(el => {
    const v = c[el.dataset.key];
    if (v === undefined) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = String(v);
  });
  $('#sensValue').textContent = c.sensitivity;
  $$('input[type="range"]').forEach(setFill);

  $('#hero').classList.toggle('off', !c.enabled);
  $('#heroTitle').textContent = tr(c.enabled ? 'heroOn' : 'heroOff');
  const triggers = [c.triggerSpace && tr('trigSpace'), c.triggerEnter && 'Enter', c.triggerTab && 'Tab'].filter(Boolean);
  $('#heroSub').textContent = !c.enabled
    ? tr('heroSubOff')
    : !c.autoSwitch
      ? tr('heroSubHotkeys')
      : triggers.length
        ? tr('heroSubAfter', triggers.length > 1 ? triggers.slice(0, -1).join(', ') + ' ' + tr('and') + ' ' + triggers.at(-1) : triggers[0])
        : tr('heroSubNone');

  const s = c.stats || {};
  $('#statConverted').textContent = s.converted || 0;
  $('#statManual').textContent = s.manual || 0;
  $('#statUndone').textContent = s.undone || 0;

  renderChips('#excList', c.exceptions || [], w => save({ exceptions: c.exceptions.filter(x => x !== w) }));
  renderChips('#appList', c.excludedApps || [], a => save({ excludedApps: c.excludedApps.filter(x => x !== a) }), a => a + '.exe');
  markRunningApps();
  renderStatus();
}

function setFill(el) {
  el.style.setProperty('--p', (el.value - el.min) / (el.max - el.min));
}

function renderChips(sel, items, onRemove, fmt = x => x) {
  const box = $(sel);
  box.innerHTML = '';
  for (const it of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = fmt(it);
    const x = document.createElement('button');
    x.title = tr('remove');
    x.appendChild(icon('x'));
    x.onclick = () => onRemove(it);
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function renderStatus() {
  const st = state.status || {};
  const c = state.config;
  const el = $('#status');
  el.className = 'status';
  let text;
  if (st.error) { el.classList.add('bad'); text = tr(st.error); }
  else if (!st.running) { el.classList.add('bad'); text = tr('errHelperDown'); }
  else if (st.layouts && (!st.layouts.en || !st.layouts.ru)) { el.classList.add('bad'); text = tr('errNeedLayouts'); }
  else if (!c.enabled) { el.classList.add('paused'); text = tr('statusPaused'); }
  else { el.classList.add('ok'); text = tr('statusOk'); }
  el.querySelector('.status-text').textContent = text;

  const badge = $('#langBadge');
  badge.className = 'lang-badge ' + (st.lang || '');
  badge.textContent = st.lang === 'en' ? 'EN' : st.lang === 'ru' ? 'RU' : '—';

  if (st.dict) $('#dictInfo').textContent = tr('dictWords', st.dict.en, st.dict.ru);
  if (st.layouts) {
    const yes = v => tr(v ? 'yes' : 'no');
    $('#layoutInfo').textContent = tr('layoutsInfo', yes(st.layouts.en), yes(st.layouts.ru));
  }
}

// ───── exceptions ─────
$('#excForm').addEventListener('submit', e => {
  e.preventDefault();
  const words = $('#excInput').value.split(/[\s,;]+/).map(w => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return;
  save({ exceptions: [...(state.config.exceptions || []), ...words] });
  $('#excInput').value = '';
});

// ───── apps ─────
function addApp(name) {
  name = name.trim().replace(/\.exe$/i, '');
  if (!name) return;
  save({ excludedApps: [...(state.config.excludedApps || []), name] });
}
$('#appForm').addEventListener('submit', e => {
  e.preventDefault();
  addApp($('#appInput').value);
  $('#appInput').value = '';
});

async function loadRunningApps() {
  const list = (await window.api.listApps()) || [];
  const box = $('#runningApps');
  box.innerHTML = '';
  $('#appSuggest').innerHTML = '';
  for (const name of list) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.app = name;
    chip.textContent = '+ ' + name;
    chip.title = tr('addToExcluded');
    chip.onclick = () => addApp(name);
    box.appendChild(chip);
    const opt = document.createElement('option');
    opt.value = name;
    $('#appSuggest').appendChild(opt);
  }
  markRunningApps();
}
function markRunningApps() {
  const ex = (state.config.excludedApps || []).map(a => a.toLowerCase());
  $$('#runningApps .chip').forEach(ch => ch.classList.toggle('added', ex.includes(ch.dataset.app.toLowerCase())));
}
$('#refreshApps').addEventListener('click', loadRunningApps);

// ───── word check ─────
let testTimer;
$('#testInput').addEventListener('input', () => {
  clearTimeout(testTimer);
  testTimer = setTimeout(runTest, 120);
});

async function runTest() {
  const text = $('#testInput').value.trim();
  const out = $('#testResult');
  if (!text) {
    out.replaceChildren(el('span', 'muted', tr('testIdle')));
    return;
  }
  const r = await window.api.analyze(text);
  if (!r) { out.replaceChildren(el('span', 'muted', tr('testNoHelper'))); return; }
  out.innerHTML = '';
  if (!r.ok) { out.appendChild(el('span', 'muted', tr('r_' + r.reason))); return; }

  const words = el('div', 'test-words');
  words.append(el('span', 'keycap word', r.text), icon('arrow'), el('span', 'keycap word' + (r.convert ? '' : ' muted'), r.converted));
  out.append(words, el('span', 'verdict ' + (r.convert ? 'yes' : 'no'), tr(r.convert ? 'willFix' : 'willKeep')));
  const curLang = r.lang === 'en' ? 'EN' : 'RU', altLang = r.lang === 'en' ? 'RU' : 'EN';
  const fmt = v => (v < -5 ? '—' : v.toFixed(2));
  const dict = inDict => (inDict ? tr('inDict') : '');
  out.appendChild(el('div', 'test-reason',
    tr('similarity', capital(tr('r_' + r.reason)), curLang, fmt(r.curScore), dict(r.curInDict), altLang, fmt(r.altScore), dict(r.altInDict))));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const capital = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ───── log ─────

function renderLog() {
  const box = $('#logList');
  box.innerHTML = '';
  for (const e of state.log) box.appendChild(logItem(e));
}

function logItem(e) {
  const item = el('div', 'log-item');
  const words = el('div', 'log-words');
  words.append(el('span', 'from', short(e.from)), icon('arrow'), el('span', '', short(e.to)));
  const meta = el('div', 'log-meta');
  meta.append(el('span', 'tag ' + e.kind, tr('kind_' + e.kind)));
  if (e.app) meta.append(el('span', '', e.app));
  meta.append(el('span', '', new Date(e.time).toLocaleTimeString(L())));
  if (e.learned) meta.append(el('span', '', tr('learnedMsg', e.learned)));
  item.append(words);
  if (e.kind === 'auto' && e.word) {
    const btn = el('button', 'btn link', tr('dontFix'));
    btn.title = tr('addToExcluded');
    btn.onclick = () => {
      save({ exceptions: [...(state.config.exceptions || []), e.word] });
      btn.textContent = tr('added');
      btn.disabled = true;
    };
    if ((state.config.exceptions || []).includes(e.word)) { btn.textContent = tr('inExceptions'); btn.disabled = true; }
    item.append(btn);
  }
  item.append(meta);
  return item;
}
const short = s => (s.length > 60 ? s.slice(0, 57) + '…' : s);

$('#clearLog').addEventListener('click', async () => {
  state.log = await window.api.clearLog();
  renderLog();
});

// ───── misc ─────
$('#resetStats').addEventListener('click', async () => {
  state.config = await window.api.resetStats();
  render();
});
$('#resetConfig').addEventListener('click', async () => {
  state.config = await window.api.resetConfig();
  render();
  runTest();
});

const UP_ERRORS = {
  Download: 'upErrDownload', BadDigest: 'upErrDigest', NoDigest: 'upErrNoDigest', NoAsset: 'upErrPackage',
  BadPackage: 'upErrPackage', Extract: 'upErrPackage', SwapFailed: 'upErrInstall', Restart: 'upErrRestart',
};
const UP_PHASES = { downloading: 'upDownloading', verifying: 'upVerifying', installing: 'upInstalling', restarting: 'upRestarting' };
const mb = n => (n / 1048576).toFixed(1);

function renderUpdate(u) {
  state.update = u;
  if (!u) return;
  const p = u.progress;
  const working = u.status === 'updating' && p;
  const failedUpdate = u.status === 'failed-update';
  let title = {
    idle: tr('upIdle', u.current),
    checking: tr('upChecking'),
    latest: tr('upLatest', u.current),
    available: tr('upAvailable', u.version),
    failed: tr('upFailed'),
  }[u.status] || '';
  let hint = u.status === 'available' ? tr('upAvailableHint2', u.current) : '';
  if (working) title = tr(UP_PHASES[p.phase] || 'upDownloading');
  if (failedUpdate) { title = tr(UP_ERRORS[p && p.error] || 'upErrDownload'); hint = ''; }
  $('#updateTitle').textContent = title;
  $('#updateHint').textContent = working ? tr('upAvailable', u.version) : hint;
  $('#updateApply').hidden = u.status !== 'available';
  $('#updateRetry').hidden = !failedUpdate;
  $('#updateManual').hidden = !failedUpdate;
  $('#updateCheck').hidden = !!working || failedUpdate;
  $('#updateCheck').disabled = u.status === 'checking';
  $('#updateProgress').hidden = !working || p.phase !== 'downloading';
  if (working && p.phase === 'downloading') {
    const frac = p.total ? Math.min(1, p.done / p.total) : 0;
    $('#upFill').style.width = `${Math.round(frac * 100)}%`;
    $('#upSize').textContent = p.total ? `${mb(p.done)} / ${mb(p.total)} MB` : '';
  }
}

$('#updateCheck').addEventListener('click', async () => renderUpdate(await window.api.checkUpdate()));
$('#updateApply').addEventListener('click', () => window.api.applyUpdate());
$('#updateRetry').addEventListener('click', () => window.api.applyUpdate());
$('#updateManual').addEventListener('click', () => window.api.openRelease());
$('#supportOpen').addEventListener('click', () => window.api.openSupport());

window.api.onEvent(msg => {
  switch (msg.type) {
    case 'update':
      renderUpdate(msg.update);
      break;
    case 'status':
      state.status = msg.status;
      renderStatus();
      break;
    case 'config':
      state.config = msg.config;
      render();
      break;
    case 'converted':
      state.config = msg.config;
      state.log.unshift(msg.entry);
      if (state.log.length > 200) state.log.length = 200;
      render();
      renderLog();
      break;
    case 'navigate':
      go(msg.page);
      break;
  }
});

(async () => {
  state = await window.api.getState();
  $('#version').textContent = 'v' + state.version;
  renderUpdate(state.update);
  render();
  renderLog();
  const page = new URLSearchParams(location.search).get('page');
  if (page) go(page);
})();
