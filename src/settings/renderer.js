const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let state = { config: {}, status: {}, log: [] };

// ───── навигация ─────
function go(page) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  if (page === 'apps' && !$('#runningApps').children.length) loadRunningApps();
}
$$('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));

// ───── привязка настроек ─────
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
    if (key === 'sensitivity') $('#sensValue').textContent = v;
    save({ [key]: v });
    if (key === 'sensitivity') runTest();
  });
});

function render() {
  const c = state.config;
  $$('[data-key]').forEach(el => {
    const v = c[el.dataset.key];
    if (v === undefined) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = String(v);
  });
  $('#sensValue').textContent = c.sensitivity;

  $('#hero').classList.toggle('off', !c.enabled);
  $('#heroTitle').textContent = c.enabled ? 'Автопереключение включено' : 'Автопереключение на паузе';
  const triggers = [c.triggerSpace && 'пробела', c.triggerEnter && 'Enter', c.triggerTab && 'Tab'].filter(Boolean);
  $('#heroSub').textContent = !c.enabled
    ? 'Нажатия не отслеживаются'
    : !c.autoSwitch
      ? 'Работают только горячие клавиши'
      : triggers.length
        ? 'Слова проверяются после ' + (triggers.length > 1 ? triggers.slice(0, -1).join(', ') + ' и ' + triggers.at(-1) : triggers[0])
        : 'Не выбрано, когда проверять слова';

  const s = c.stats || {};
  $('#statConverted').textContent = s.converted || 0;
  $('#statManual').textContent = s.manual || 0;
  $('#statUndone').textContent = s.undone || 0;

  renderChips('#excList', c.exceptions || [], w => save({ exceptions: c.exceptions.filter(x => x !== w) }));
  renderChips('#appList', c.excludedApps || [], a => save({ excludedApps: c.excludedApps.filter(x => x !== a) }), a => a + '.exe');
  markRunningApps();
  renderStatus();
}

function renderChips(sel, items, onRemove, fmt = x => x) {
  const box = $(sel);
  box.innerHTML = '';
  for (const it of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = fmt(it);
    const x = document.createElement('button');
    x.title = 'Удалить';
    x.textContent = '✕';
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
  if (st.error) { el.classList.add('bad'); text = st.error; }
  else if (!st.running) { el.classList.add('bad'); text = 'Хелпер не запущен'; }
  else if (st.layouts && (!st.layouts.en || !st.layouts.ru)) { el.classList.add('bad'); text = 'Нужны раскладки EN и RU'; }
  else if (!c.enabled) { el.classList.add('paused'); text = 'На паузе'; }
  else { el.classList.add('ok'); text = 'Работает'; }
  el.querySelector('.status-text').textContent = text;

  const badge = $('#langBadge');
  badge.className = 'lang-badge ' + (st.lang || '');
  badge.textContent = st.lang === 'en' ? 'EN' : st.lang === 'ru' ? 'RU' : '—';

  if (st.dict) $('#dictInfo').textContent = `${st.dict.en} / ${st.dict.ru} слов`;
  if (st.layouts) {
    const yes = v => (v ? 'есть' : 'нет');
    $('#layoutInfo').textContent = `английская — ${yes(st.layouts.en)}, русская — ${yes(st.layouts.ru)}`;
  }
}

// ───── исключения ─────
$('#excForm').addEventListener('submit', e => {
  e.preventDefault();
  const words = $('#excInput').value.split(/[\s,;]+/).map(w => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return;
  save({ exceptions: [...(state.config.exceptions || []), ...words] });
  $('#excInput').value = '';
});

// ───── программы ─────
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
    chip.title = 'Добавить в исключения';
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

// ───── проверка слова ─────
let testTimer;
$('#testInput').addEventListener('input', () => {
  clearTimeout(testTimer);
  testTimer = setTimeout(runTest, 120);
});

async function runTest() {
  const text = $('#testInput').value.trim();
  const out = $('#testResult');
  if (!text) {
    out.innerHTML = '<span class="muted">Здесь будет видно, что программа сделает со словом</span>';
    return;
  }
  const r = await window.api.analyze(text);
  if (!r) { out.innerHTML = '<span class="muted">Хелпер не отвечает</span>'; return; }
  out.innerHTML = '';
  if (!r.ok) { out.appendChild(el('span', 'muted', r.reason)); return; }

  const words = el('div', 'test-words');
  words.append(el('span', '', r.text), el('span', 'arrow', r.convert ? '→' : '·'), el('span', r.convert ? '' : 'muted', r.converted));
  out.append(words, el('span', 'verdict ' + (r.convert ? 'yes' : 'no'), r.convert ? 'исправит' : 'оставит как есть'));
  const curLang = r.lang === 'en' ? 'EN' : 'RU', altLang = r.lang === 'en' ? 'RU' : 'EN';
  const fmt = v => (v < -5 ? '—' : v.toFixed(2));
  out.appendChild(el('div', 'test-reason',
    `${capital(r.reason)}. Похожесть на слово: ${curLang} ${fmt(r.curScore)}${r.curInDict ? ' (в словаре)' : ''}, ` +
    `${altLang} ${fmt(r.altScore)}${r.altInDict ? ' (в словаре)' : ''}.`));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const capital = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ───── журнал ─────
const KIND = { auto: 'авто', manual: 'вручную', undo: 'отмена', selection: 'выделение' };

function renderLog() {
  const box = $('#logList');
  box.innerHTML = '';
  for (const e of state.log) box.appendChild(logItem(e));
}

function logItem(e) {
  const item = el('div', 'log-item');
  const words = el('div', 'log-words');
  words.append(el('span', 'from', short(e.from)), el('span', 'muted', '→'), el('span', '', short(e.to)));
  const meta = el('div', 'log-meta');
  meta.append(el('span', 'tag ' + e.kind, KIND[e.kind] || e.kind));
  if (e.app) meta.append(el('span', '', e.app));
  meta.append(el('span', '', new Date(e.time).toLocaleTimeString('ru-RU')));
  if (e.learned) meta.append(el('span', '', `«${e.learned}» добавлено в исключения`));
  item.append(words);
  if (e.kind === 'auto' && e.word) {
    const btn = el('button', 'link', 'не исправлять');
    btn.title = 'Добавить в исключения';
    btn.onclick = () => {
      save({ exceptions: [...(state.config.exceptions || []), e.word] });
      btn.textContent = 'добавлено';
      btn.disabled = true;
    };
    if ((state.config.exceptions || []).includes(e.word)) { btn.textContent = 'в исключениях'; btn.disabled = true; }
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

// ───── прочее ─────
$('#resetStats').addEventListener('click', async () => {
  state.config = await window.api.resetStats();
  render();
});
$('#resetConfig').addEventListener('click', async () => {
  state.config = await window.api.resetConfig();
  render();
  runTest();
});

function renderUpdate(u) {
  if (!u) return;
  const title = {
    idle: `Установлена версия ${u.current}`,
    checking: 'Проверяем обновления…',
    latest: `Версия ${u.current} — последняя`,
    available: `Доступна версия ${u.version}`,
    failed: 'Не удалось проверить обновления',
  }[u.status] || '';
  $('#updateTitle').textContent = title;
  $('#updateHint').textContent = u.status === 'available' ? `У вас ${u.current}. Обновление скачает и установит NIMVORO.` : '';
  $('#updateApply').hidden = u.status !== 'available';
  $('#updateCheck').disabled = u.status === 'checking';
}

$('#updateCheck').addEventListener('click', async () => renderUpdate(await window.api.checkUpdate()));
$('#updateApply').addEventListener('click', () => window.api.applyUpdate());

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
