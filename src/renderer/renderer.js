const $ = (id) => document.getElementById(id);
const tabs = [];
let active = null;
const bySid = new Map();

// The window is shown on a Mac or on Windows. Shortcut labels and a few layout details follow the computer.
const IS_MAC = window.api.platform === 'darwin';
document.body.classList.add(IS_MAC ? 'mac' : 'notmac');
/** On Windows plain Ctrl+B is tmux's prefix key and Ctrl+Shift+B is free, so the panel keys differ from the Mac's. */
const KEYS = IS_MAC
  ? { sessions: '⌘B', files: '⌘⇧B', fullEditor: '⌘⇧F', settings: '⌘,', save: '⌘S' }
  : { sessions: 'Ctrl+Shift+B', files: 'Ctrl+Shift+E', fullEditor: 'Ctrl+Shift+F', settings: 'Ctrl+,', save: 'Ctrl+S' };
/** Text written with Mac shortcut symbols, shown with this computer's keys. */
const keysText = (t) => String(t)
  .replace('⌘⇧B', KEYS.files).replace('⌘B', KEYS.sessions).replace('⌘⇧F', KEYS.fullEditor).replace('⌘,', KEYS.settings).replace('⌘S', KEYS.save);
for (const n of document.querySelectorAll('[title]')) n.title = keysText(n.title);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function note(msg) {
  $('notice').textContent = msg;
}

/* ---------- helpers ---------- */

/** A 16px line icon from static path data; colour follows the button's text colour. */
const ICONS = {
  save: '<path d="M3 2.5h8.2l2.3 2.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M5 2.5V6h5.5V2.5M5 13.5V9.5h6v4"/>',
  reload: '<path d="M13.2 2.8v3.4H9.8"/><path d="M13 6.2A5.3 5.3 0 1 0 12.4 11"/>',
  expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  shrink: '<path d="M6 2.5V6H2.5M10 2.5V6h3.5M13.5 10H10v3.5M2.5 10H6v3.5"/>',
  exec: '<circle cx="8" cy="8" r="5.6"/><path d="M6.7 5.5v5l4-2.5z" fill="currentColor"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
};
const svgIcon = (name) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name]}</svg>`;
/** An icon-only button. The tooltip doubles as the accessible name; `setIcon` swaps icon and tooltip together. */
function iconButton(icon, tip, onclick) {
  const b = el('button', 'icon');
  b.setIcon = (name, text) => { b.innerHTML = svgIcon(name); b.title = text; b.setAttribute('aria-label', text.split(/\s*[(:]/)[0]); };  /* aria-label: just the action, without the explanation */
  b.setIcon(icon, tip);
  b.onclick = onclick;
  return b;
}

/** Run `fn` once the browser has laid out. A short timer backs up requestAnimationFrame, which pauses for hidden windows. */
function afterLayout(fn) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(run);
  setTimeout(run, 60);
}


const joinPath = (dir, name) => (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
const parentPath = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
const human = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');

// Per-viewer preferences; storage can be unavailable, so never depend on it.
function readPref(key) { try { return localStorage.getItem('tavrix.' + key); } catch { return null; } }
function writePref(key, value) { try { localStorage.setItem('tavrix.' + key, value); } catch { /* ignore */ } }

function ask(title, value = '', { secret = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('ask');
    $('askTitle').textContent = title;
    $('askInput').type = secret ? 'password' : 'text';
    $('askInput').value = value;
    // Answer as soon as the user does. A dialog's "close" event only arrives with the next animation frame, which a hidden
    // or covered window does not produce, so waiting for it could leave a caller waiting indefinitely.
    let answered = false;
    const answer = (v) => {
      if (answered) return;
      answered = true;
      resolve(v || null);
    };
    $('askForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('askInput').value;
      dlg.close();
      answer(secret ? v : v.trim()); // passwords may legitimately start or end with spaces
    };
    $('askCancel').onclick = () => { dlg.close(); answer(null); };
    dlg.onclose = () => answer(null); // Escape, or anything else that closes it without an answer
    dlg.showModal();
    $('askInput').select();
  });
}

function showMenu(x, y, items) {
  const m = $('menu');
  m.textContent = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const d = el('div', '', it.label);
    d.onclick = () => { hideMenu(); it.run(); };
    m.appendChild(d);
  }
  m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 8) + 'px';
}
function hideMenu() { $('menu').hidden = true; }
window.addEventListener('click', hideMenu);
window.addEventListener('blur', hideMenu);
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Monaco cancels in-flight work when a model is disposed; that rejection is expected.
window.addEventListener('unhandledrejection', (e) => { if (e.reason && e.reason.message === 'Canceled') e.preventDefault(); });

let monacoPromise;
function loadMonaco() {
  monacoPromise ??= new Promise((resolve, reject) => {
    const base = new URL('../../node_modules/monaco-editor/min/', location.href).href;
    // Monaco's worker bootstrap needs an absolute baseUrl; a blob worker pulls in the bundled worker code.
    window.MonacoEnvironment = {
      getWorkerUrl: () => URL.createObjectURL(new Blob(
        [`self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}vs/base/worker/workerMain.js');`],
        { type: 'text/javascript' },
      )),
    };
    require.config({ paths: { vs: base + 'vs' } });
    require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  });
  return monacoPromise;
}

/* ---------- resizable panels ---------- */

// Remembered sizes: the two side panels in pixels, the editor's share of the area it splits with the terminals.
const sizes = (() => { try { return { sessions: 220, files: 260, editor: 0.5, ...JSON.parse(readPref('sizes') || '{}') }; } catch { return { sessions: 220, files: 260, editor: 0.5 }; } })();
const saveSizes = () => writePref('sizes', JSON.stringify(sizes));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function applySizes() {
  document.documentElement.style.setProperty('--sessions-w', clamp(sizes.sessions, 140, 520) + 'px');
  document.documentElement.style.setProperty('--files-w', clamp(sizes.files, 160, 640) + 'px');
}

/** Wire pointer drag and arrow keys to a splitter. `move(deltaPx, start)` gets the distance from where the drag began. */
function wireSplitter(handle, axis, { begin, move, end, reset }) {
  const horizontal = axis === 'x';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = begin();
    const from = horizontal ? e.clientX : e.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch { /* the window listeners below cover it */ }
    handle.classList.add('drag');
    document.body.classList.add('resizing', horizontal ? 'rs-x' : 'rs-y');
    // Listen on the window, not the handle: the handle moves as the panel resizes and can slip out from under the pointer.
    const onMove = (ev) => move((horizontal ? ev.clientX : ev.clientY) - from, start);
    const onUp = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
      handle.classList.remove('drag');
      document.body.classList.remove('resizing', 'rs-x', 'rs-y');
      end?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
  });
  handle.addEventListener('dblclick', () => { reset?.(); end?.(); });
  handle.addEventListener('keydown', (e) => {
    const keys = horizontal ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    move(keys[e.key] * (e.shiftKey ? 100 : 20), begin());
    end?.();
  });
}

/** A splitter that sets the width of the panel beside it (sidebar, file panel). */
function sizeSplitter(handle, key, min, max, def) {
  wireSplitter(handle, 'x', {
    begin: () => sizes[key],
    move: (d, start) => { sizes[key] = clamp(start + d, min, max); applySizes(); for (const t of tabs) scheduleRefit(t); },
    end: () => { saveSizes(); for (const t of tabs) scheduleRefit(t); },
    reset: () => { sizes[key] = def; applySizes(); },
  });
}

/**
 * A splitter between two flex siblings. Only the border between them moves: their combined size stays the same, and each
 * keeps at least `min` pixels. Sizes are stored as flex-grow ratios so they survive the window being resized.
 */
function pairSplitter(handle, axis, getPair, { min = 80, onChange, onEnd, onReset } = {}) {
  const horizontal = axis === 'x';
  const size = (e) => (horizontal ? e.offsetWidth : e.offsetHeight);
  const grow = (e) => parseFloat(getComputedStyle(e).flexGrow) || 1;
  wireSplitter(handle, axis, {
    begin: () => { const [a, b] = getPair(); return { a, b, sa: size(a), sb: size(b), ga: grow(a), gb: grow(b) }; },
    move: (d, st) => {
      const total = st.sa + st.sb;
      const na = clamp(st.sa + d, Math.min(min, total / 2), total - Math.min(min, total / 2));
      const g = st.ga + st.gb;
      st.a.style.flexGrow = String((g * na) / total);
      st.b.style.flexGrow = String((g * (total - na)) / total);
      onChange?.();
    },
    end: onEnd,
    reset: () => { const [a, b] = getPair(); a.style.flexGrow = ''; b.style.flexGrow = ''; onReset?.(); onChange?.(); },
  });
}

function scheduleRefit(tab) {
  if (tab.refitQueued) return;
  tab.refitQueued = true;
  afterLayout(() => { tab.refitQueued = false; refit(tab); });
}

/** One splitter between each pair of neighbouring terminals; rebuilt whenever panes come or go or the direction changes. */
function rebuildPaneSplitters(tab) {
  // Shares are relative weights; after a pane is added or closed they may no longer add up to "fill the area".
  const weights = tab.panes.map((p) => parseFloat(p.el.style.flexGrow) || 1);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  tab.panes.forEach((p, i) => { p.el.style.flexGrow = String((weights[i] * tab.panes.length) / sum); });
  for (const h of tab.termEl.querySelectorAll(':scope > .splitter')) h.remove();
  const horizontal = tab.termEl.classList.contains('row');
  tab.panes.forEach((pane, i) => {
    if (i === 0) return;
    const prev = tab.panes[i - 1];
    const h = el('div', 'splitter ' + (horizontal ? 'v' : 'h'));
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
    h.tabIndex = 0;
    h.title = 'Drag to resize; double-click to make equal';
    pairSplitter(h, horizontal ? 'x' : 'y', () => [prev.el, pane.el], { min: 80, onChange: () => scheduleRefit(tab), onEnd: () => scheduleRefit(tab) });
    tab.termEl.insertBefore(h, pane.el);
  });
}

/** The divider between the terminals and the editor below them. */
function wireEditorSplitter(tab) {
  const frac = () => tab.editorEl.offsetHeight / ((tab.termEl.offsetHeight + tab.editorEl.offsetHeight) || 1);
  pairSplitter(tab.hsplit, 'y', () => [tab.termEl, tab.editorEl], {
    min: 90,
    onChange: () => scheduleRefit(tab),
    onEnd: () => { sizes.editor = clamp(frac(), 0.1, 0.9); saveSizes(); scheduleRefit(tab); },
    onReset: () => { sizes.editor = 0.5; saveSizes(); },
  });
}
/** Give a new tab the editor/terminal proportion the user last chose. */
function applyEditorShare(tab) {
  const f = clamp(sizes.editor, 0.1, 0.9);
  tab.termEl.style.flexGrow = String(1 - f);
  tab.editorEl.style.flexGrow = String(f);
}

applySizes();
sizeSplitter($('sessionsSplit'), 'sessions', 140, 520, 220);

/* ---------- terminal settings ---------- */

const ANSI = (c) => ({ black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7], brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11], brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15] });
const TERM_THEMES = {
  'tavrix-dark': { label: 'Tavrix Dark', background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad', selectionBackground: '#264f78', ...ANSI(['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']) },
  light: { label: 'Light', background: '#ffffff', foreground: '#1e1e1e', cursor: '#1e1e1e', selectionBackground: '#add6ff', ...ANSI(['#000000', '#cd3131', '#00a000', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555', '#666666', '#cd3131', '#14ce14', '#b5ba00', '#0451a5', '#bc05bc', '#0598bc', '#a5a5a5']) },
  'solarized-dark': { label: 'Solarized Dark', background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642', ...ANSI(['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']) },
  dracula: { label: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', ...ANSI(['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']) },
  monokai: { label: 'Monokai', background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e', ...ANSI(['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']) },
};

// Replaced by the saved settings as soon as they arrive; these only cover the first instant.
let settings = {
  terminal: { fontFamily: 'Menlo, Monaco, Consolas, "Cascadia Mono", "Courier New", monospace', fontSize: 13, theme: 'tavrix-dark', scrollback: 5000, cursorStyle: 'block', cursorBlink: true, copyOnSelect: false },
  connection: { keepAliveSec: 30, compression: false, connectTimeoutSec: 20 },
  defaults: null,
};

/** Global terminal settings with this session's overrides on top. */
const effectivePrefs = (tab) => ({ ...settings.terminal, ...(tab?.termOverride || {}) });

function termOptions(prefs) {
  const family = /monospace/i.test(prefs.fontFamily) ? prefs.fontFamily : prefs.fontFamily + ', monospace';
  return { fontFamily: family, fontSize: prefs.fontSize, cursorStyle: prefs.cursorStyle, cursorBlink: prefs.cursorBlink, scrollback: prefs.scrollback, theme: TERM_THEMES[prefs.theme] || TERM_THEMES['tavrix-dark'] };
}

function applyPrefsToPane(tab, pane) {
  const o = termOptions(effectivePrefs(tab));
  for (const [k, v] of Object.entries(o)) pane.term.options[k] = v;
  pane.el.style.background = o.theme.background;
}

function applyPrefsToAll() {
  for (const tab of tabs) {
    for (const pane of tab.panes) applyPrefsToPane(tab, pane);
    refit(tab);
  }
}

const FONT_CHOICES = ['Menlo', 'Monaco', 'SF Mono', 'Consolas', 'Cascadia Mono', 'Courier New', 'JetBrains Mono', 'Fira Code', 'Source Code Pro'];

/** Build the terminal appearance controls. With `withDefault`, every control can be left on "Default" (per-session overrides). */
function terminalFields(root, prefix, { withDefault }) {
  root.textContent = '';
  const add = (label, control, id) => {
    control.id = `${prefix}-${id}`;
    const l = el('label', 'tfield');
    l.append(el('span', '', label), control);
    root.append(l);
    return control;
  };
  const select = (options) => {
    const sel = el('select');
    if (withDefault) sel.append(new Option('Default', ''));
    for (const [v, t] of options) sel.append(new Option(t, v));
    return sel;
  };
  const font = add('Font', el('input'), 'font');
  font.setAttribute('list', `${prefix}-fonts`);
  font.placeholder = withDefault ? 'default' : 'Menlo';
  const dl = el('datalist');
  dl.id = `${prefix}-fonts`;
  for (const f of FONT_CHOICES) dl.append(new Option(f));
  root.append(dl);
  const size = add('Font size', el('input'), 'size');
  size.type = 'number'; size.min = 8; size.max = 32; size.placeholder = withDefault ? 'default' : '';
  add('Theme', select(Object.entries(TERM_THEMES).map(([k, t]) => [k, t.label])), 'theme');
  const sb = add('Scrollback lines', el('input'), 'scrollback');
  sb.type = 'number'; sb.min = 0; sb.max = 100000; sb.placeholder = withDefault ? 'default' : '';
  add('Cursor', select([['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']]), 'cursor');
  add('Cursor blinks', select([['true', 'Yes'], ['false', 'No']]), 'blink');
  add('Copy on select', select([['true', 'Yes'], ['false', 'No']]), 'copy');
}

function fillTerminalFields(prefix, p = {}) {
  const set = (id, v) => { $(`${prefix}-${id}`).value = v === undefined || v === null ? '' : String(v); };
  set('font', p.fontFamily); set('size', p.fontSize); set('theme', p.theme); set('scrollback', p.scrollback);
  set('cursor', p.cursorStyle); set('blink', p.cursorBlink); set('copy', p.copyOnSelect);
}

/** Only the controls that were set; blank/Default ones are left out so the global value applies. */
function readTerminalFields(prefix) {
  const v = (id) => $(`${prefix}-${id}`).value.trim();
  const num = (id) => (v(id) === '' ? undefined : Number(v(id)));
  const flag = (id) => (v(id) === '' ? undefined : v(id) === 'true');
  const out = { fontFamily: v('font') || undefined, fontSize: num('size'), theme: v('theme') || undefined, scrollback: num('scrollback'), cursorStyle: v('cursor') || undefined, cursorBlink: flag('blink'), copyOnSelect: flag('copy') };
  return Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined));
}

window.api.settings.get().then((s) => {
  settings = s;
  applyPrefsToAll();
  // First launch after install: show the quick tour once the window has settled.
  if (!s.tourSeen) setTimeout(() => startTour(0), 700);
});
window.api.settings.onChanged((s) => { settings = { ...settings, ...s }; applyPrefsToAll(); });

/* ---------- tabs ---------- */

function createTab(title) {
  const tab = { title, sid: null, cwd: '/', editing: null, browseSeq: 0, dirCache: new Map(), selectedEl: null };

  tab.header = el('div', 'tab');
  const label = el('span', '', title);
  const close = el('span', 'close', '×');
  tab.header.append(label, close);
  tab.header.onclick = () => activate(tab);
  close.onclick = (e) => { e.stopPropagation(); closeTab(tab); };

  tab.pane = el('div', 'pane');
  const aside = el('aside');
  const tools = el('div', 'ftools');
  const mkBtn = (label, title, fn) => { const b = el('button', '', label); b.title = title; b.onclick = fn; tools.appendChild(b); };
  mkBtn('↑', 'Parent folder', () => tab.sid && browse(tab, parentPath(tab.cwd)));
  mkBtn('⟳', 'Refresh', () => tab.sid && browse(tab, tab.cwd, { fresh: true }));
  mkBtn('+ File', 'New empty file', () => newFile(tab));
  mkBtn('+ Folder', 'New folder', () => newFolder(tab));
  mkBtn('Upload', 'Upload files or folders', () => upload(tab));
  tab.cwdEl = el('div', 'cwd', '/');
  tab.filesEl = el('ul', 'files');
  aside.append(tools, tab.cwdEl, tab.filesEl);
  aside.addEventListener('dragover', (e) => { e.preventDefault(); aside.classList.add('dragover'); });
  aside.addEventListener('dragleave', (e) => { if (e.target === aside || !aside.contains(e.relatedTarget)) aside.classList.remove('dragover'); });
  aside.addEventListener('drop', (e) => {
    e.preventDefault();
    aside.classList.remove('dragover');
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathFor(f)).filter(Boolean);
    if (paths.length) upload(tab, paths);
  });
  tab.filesEl.addEventListener('contextmenu', (e) => {
    if (e.target !== tab.filesEl) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'New file', run: () => newFile(tab) },
      { label: 'New folder', run: () => newFolder(tab) },
      { label: 'Upload here…', run: () => upload(tab) },
      { label: 'Refresh', run: () => browse(tab, tab.cwd, { fresh: true }) },
    ]);
  });
  const work = el('div', 'work');
  tab.termEl = el('div', 'terms row');
  tab.panes = [];
  tab.focused = null;
  tab.id = nextTabId++;
  tab.docs = []; // open files, one editor tab each
  tab.doc = null; // the one being shown
  // The single-file names older code and tests used, now answered by the active file.
  Object.defineProperties(tab, {
    editing: { get: () => tab.doc?.path ?? null },
    model: { get: () => tab.doc?.model ?? null },
    editDirty: { get: () => Boolean(tab.doc?.dirty) },
    editStat: { get: () => tab.doc?.stat ?? null },
  });
  tab.editorEl = el('div', 'editor');
  tab.editorEl.hidden = true;
  tab.docTabsEl = el('div', 'doctabs');
  tab.docTabsEl.hidden = true;
  const bar = el('div', 'editbar');
  tab.editPathEl = el('span', 'editpath');
  const autoLabel = el('label', 'auto');
  tab.autoBox = el('input');
  tab.autoBox.type = 'checkbox';
  tab.autoBox.checked = readPref('autosave') === '1';
  tab.autoBox.onchange = () => {
    writePref('autosave', tab.autoBox.checked ? '1' : '0');
    for (const d of tab.docs) { d.autoPaused = false; if (tab.autoBox.checked && d.dirty) scheduleAutoSave(tab, d); }
  };
  autoLabel.append(tab.autoBox, ' Auto-save');
  autoLabel.title = 'Save automatically 1.5 s after you stop typing';
  tab.execBtn = iconButton('exec', 'Make executable (chmod +x): this file starts with #! but is not executable', () => makeExecutable(tab));
  tab.execBtn.hidden = true;
  const reload = iconButton('reload', 'Reload from the server (discards what is in the editor)', () => reloadFile(tab));
  const save = iconButton('save', `Save (${KEYS.save})`, () => saveFile(tab));
  const closeEdit = iconButton('close', 'Close this file (its tab); other open files stay', () => closeDoc(tab, tab.doc));
  tab.fullBtn = iconButton('expand', `Full screen editor (${KEYS.fullEditor})`, toggleFullEditor);
  bar.append(tab.editPathEl, autoLabel, tab.execBtn, reload, save, tab.fullBtn, closeEdit);
  tab.monacoEl = el('div', 'monaco');
  tab.editorEl.append(tab.docTabsEl, bar, tab.monacoEl);
  tab.statusEl = el('div', 'status');
  tab.msgEl = el('span', 'msg');
  tab.progEl = el('progress');
  tab.progEl.hidden = true;
  tab.progEl.max = 1;
  tab.cancelBtn = el('button', '', 'Cancel');
  tab.cancelBtn.hidden = true;
  tab.cancelBtn.onclick = () => { tab.cancelBtn.disabled = true; window.api.cancelTransfer(tab.sid); };
  const sbtn = (label, title, fn, term = true) => { const b = el('button', term ? 'sb term' : 'sb', label); b.title = title; b.onclick = fn; return b; };
  tab.statusEl.append(
    tab.msgEl, tab.progEl, tab.cancelBtn,
    sbtn('Split →', 'Split the terminal side by side', () => splitPane(tab, 'row')),
    sbtn('Split ↓', 'Split the terminal top and bottom', () => splitPane(tab, 'col')),
    sbtn('Close pane', 'Close the focused terminal pane', () => closePane(tab, tab.focused)),
    sbtn('Tunnels', 'Port forwarding', () => openTunnels(tab)),
  );
  // Files-only (SFTP) sessions show this instead of a terminal until a file is opened.
  tab.emptyEl = el('div', 'sftp-empty');
  tab.emptyHead = el('strong', '');
  tab.emptyBody = el('p', '');
  tab.emptyEl.append(tab.emptyHead, tab.emptyBody);
  tab.hsplit = el('div', 'splitter h hsplit');
  tab.hsplit.setAttribute('role', 'separator');
  tab.hsplit.setAttribute('aria-orientation', 'horizontal');
  tab.hsplit.tabIndex = 0;
  tab.hsplit.title = 'Drag to resize the terminals and the editor; double-click to reset';
  work.append(tab.termEl, tab.hsplit, tab.emptyEl, tab.editorEl, tab.statusEl);
  const fsplit = el('div', 'splitter v fsplit');
  fsplit.setAttribute('role', 'separator');
  fsplit.setAttribute('aria-orientation', 'vertical');
  fsplit.tabIndex = 0;
  fsplit.title = 'Drag to resize the file panel; double-click to reset';
  sizeSplitter(fsplit, 'files', 160, 640, 260);
  tab.pane.append(aside, fsplit, work);
  wireEditorSplitter(tab);
  applyEditorShare(tab);


  $('tabbar').appendChild(tab.header);
  $('panes').appendChild(tab.pane);
  tabs.push(tab);
  activate(tab);
  return tab;
}

/* ---------- terminal panes ---------- */

/** Add a terminal pane. With shell=false it is only a text area for messages (no remote shell). */
async function addPane(tab, { shell = true } = {}) {
  const pane = { el: el('div', 'tpane'), shellId: null };
  pane.term = new Terminal(termOptions(effectivePrefs(tab)));
  pane.el.style.background = termOptions(effectivePrefs(tab)).theme.background;
  pane.fit = new FitAddon.FitAddon();
  pane.term.loadAddon(pane.fit);
  tab.termEl.appendChild(pane.el);
  pane.term.open(pane.el);
  if (!IS_MAC) {
    // Like Windows Terminal: Ctrl+C copies only when text is selected (otherwise it is the interrupt key), Ctrl+Shift+C always
    // copies, and Ctrl+V / Ctrl+Shift+V paste through the browser's own paste event (returning false stops a stray ^V).
    pane.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && (e.shiftKey || pane.term.hasSelection())) {
        if (pane.term.hasSelection()) { navigator.clipboard?.writeText(pane.term.getSelection()).catch(() => {}); pane.term.clearSelection(); }
        return false;
      }
      return k !== 'v';
    });
  }
  pane.el.addEventListener('mousedown', () => { tab.focused = pane; });
  pane.term.onData((d) => tab.sid && pane.shellId && window.api.write(tab.sid, pane.shellId, d));
  pane.term.onSelectionChange(() => {
    if (effectivePrefs(tab).copyOnSelect && pane.term.hasSelection()) navigator.clipboard?.writeText(pane.term.getSelection()).catch(() => {});
  });
  tab.panes.push(pane);
  tab.focused = pane;
  rebuildPaneSplitters(tab);
  refit(tab);
  if (shell && tab.sid) {
    try {
      pane.shellId = await window.api.openShell(tab.sid, pane.term.cols, pane.term.rows);
      refit(tab);
      pane.term.focus();
    } catch (err) {
      pane.term.write('\r\n\x1b[31mCould not open a shell:\x1b[0m ' + (err.message || err) + '\r\n');
    }
  }
  return pane;
}

function splitPane(tab, dir) {
  if (!tab.sid) return;
  tab.termEl.className = 'terms ' + dir; // one direction per tab: all panes sit in a row or a column
  for (const p of tab.panes) p.el.style.flexGrow = ''; // a new direction starts from equal shares
  addPane(tab);
}

function removePane(tab, pane) {
  pane.term.dispose();
  pane.el.remove();
  tab.panes.splice(tab.panes.indexOf(pane), 1);
  if (tab.focused === pane) tab.focused = tab.panes[tab.panes.length - 1] || null;
  rebuildPaneSplitters(tab);
  refit(tab);
}

function closePane(tab, pane) {
  if (!pane || tab.panes.length < 2) { tab.msgEl.textContent = 'This is the last terminal; close the tab instead'; return; }
  if (tab.sid && pane.shellId) window.api.closeShell(tab.sid, pane.shellId);
  removePane(tab, pane);
}

function paneByShell(sid, shellId) {
  const tab = bySid.get(sid);
  const pane = tab && tab.panes.find((p) => p.shellId === shellId);
  return { tab, pane };
}

function activate(tab) {
  active = tab;
  for (const t of tabs) {
    t.header.classList.toggle('active', t === tab);
    t.pane.classList.toggle('active', t === tab);
  }
  afterLayout(() => refit(tab));
  checkExternalChange(tab);
}

function refit(tab) {
  for (const pane of tab.panes) {
    try {
      pane.fit.fit();
      const { cols, rows } = pane.term;
      if (tab.sid && pane.shellId && (pane.sentCols !== cols || pane.sentRows !== rows)) {
        pane.sentCols = cols;
        pane.sentRows = rows;
        window.api.resize(tab.sid, pane.shellId, cols, rows);
      }
    } catch { /* pane hidden */ }
  }
}

function closeTab(tab) {
  const dirty = tab.docs.filter((d) => d.dirty);
  if (dirty.length && !confirm(`Discard unsaved changes in ${dirty.length} file${dirty.length === 1 ? '' : 's'}?`)) return;
  if (tab.sid) { window.api.disconnect(tab.sid); bySid.delete(tab.sid); }
  for (const d of tab.docs) clearTimeout(d.autoTimer);
  tab.editor?.dispose();
  for (const d of tab.docs) d.model.dispose();
  if (document.body.classList.contains('editor-max')) setFullEditor(false);
  for (const pane of tab.panes) pane.term.dispose();
  tab.header.remove();
  tab.pane.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  if (active === tab) active = null;
  if (tabs.length) activate(tabs[tabs.length - 1]);
}

/* ---------- files ---------- */

const DIR_CACHE_MAX = 60;
const dirSignature = (items) => items.map((e) => `${e.name}|${e.isDir ? 'd' : e.isLink ? 'l' : 'f'}|${e.size}|${e.mtime}|${e.mode}`).join('\n');

function rememberDir(tab, path, items) {
  tab.dirCache.delete(path); // re-insert so the Map's order is least-recently-used first
  tab.dirCache.set(path, { items, sig: dirSignature(items) });
  if (tab.dirCache.size > DIR_CACHE_MAX) tab.dirCache.delete(tab.dirCache.keys().next().value);
  return tab.dirCache.get(path).sig;
}

function renderDir(tab, path, items) {
  tab.cwd = path;
  tab.cwdEl.textContent = path;
  tab.selectedEl = null;
  const frag = document.createDocumentFragment();
  if (path !== '/') {
    const up = el('li', '', '📁 ..');
    up.onclick = () => browse(tab, parentPath(path));
    frag.appendChild(up);
  }
  const select = (li) => {
    tab.selectedEl?.classList.remove('sel');
    tab.selectedEl = li;
    li.classList.add('sel');
  };
  for (const e of items) {
    const li = el('li');
    li.append(el('span', '', (e.isDir ? '📁 ' : e.isLink ? '🔗 ' : '📄 ') + e.name), el('small', '', e.isDir ? '' : human(e.size)));
    const full = joinPath(path, e.name);
    // A folder opens on one click; a file is selected on click and opened in the editor on double-click.
    li.onclick = () => (e.isDir ? browse(tab, full) : select(li));
    if (!e.isDir) li.ondblclick = () => openFile(tab, full);
    li.oncontextmenu = (ev) => {
      ev.preventDefault();
      select(li);
      showMenu(ev.clientX, ev.clientY, [
        { label: e.isDir ? 'Open folder' : 'Edit', run: () => (e.isDir ? browse(tab, full) : openFile(tab, full)) },
        { label: 'Download…', run: () => download(tab, [full]) },
        '-',
        { label: 'Rename…', run: () => renameEntry(tab, e, full) },
        { label: 'Permissions…', run: () => chmodEntry(tab, e, full) },
        { label: 'Delete', run: () => deleteEntry(tab, e, full) },
      ]);
    };
    frag.appendChild(li);
  }
  tab.filesEl.replaceChildren(frag);
}

/**
 * Open a folder. A folder seen before is shown immediately from memory and refreshed in the background; otherwise the
 * path updates at once and the list dims if the server is slow. Only the newest navigation may touch the screen, so a
 * slow reply for a folder you already left cannot overwrite the one you are in. `fresh` skips the remembered list
 * (used after changes made by this app).
 */
async function browse(tab, path, { fresh = false } = {}) {
  if (!tab.sid) return;
  const seq = ++tab.browseSeq;
  const cached = fresh ? undefined : tab.dirCache.get(path);
  if (cached) renderDir(tab, path, cached.items);
  else tab.cwdEl.textContent = path + '  …';
  const dimTimer = cached ? null : setTimeout(() => { if (seq === tab.browseSeq) tab.filesEl.classList.add('loading'); }, 120);
  try {
    const items = await window.api.list(tab.sid, path);
    if (seq !== tab.browseSeq) return;
    const sig = rememberDir(tab, path, items);
    if (!cached || cached.sig !== sig) renderDir(tab, path, items);
    else tab.cwdEl.textContent = path;
  } catch (err) {
    if (seq !== tab.browseSeq) return;
    tab.cwdEl.textContent = tab.cwd;
    tab.msgEl.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  } finally {
    clearTimeout(dimTimer);
    if (seq === tab.browseSeq) tab.filesEl.classList.remove('loading');
  }
}

async function guarded(tab, label, fn) {
  try {
    await fn();
  } catch (err) {
    tab.msgEl.textContent = label + ' failed: ' + (err.message || err);
  }
}

function newFolder(tab) {
  if (!tab.sid) return;
  return guarded(tab, 'New folder', async () => {
    const name = await ask('New folder name');
    if (!name) return;
    if (name.includes('/')) throw new Error('Name cannot contain "/"');
    await window.api.mkdir(tab.sid, joinPath(tab.cwd, name));
    await browse(tab, tab.cwd, { fresh: true });
  });
}

function renameEntry(tab, e, full) {
  return guarded(tab, 'Rename', async () => {
    const name = await ask('Rename ' + e.name, e.name);
    if (!name || name === e.name) return;
    if (name.includes('/')) throw new Error('Name cannot contain "/"');
    await window.api.rename(tab.sid, full, joinPath(tab.cwd, name));
    closeDocsUnder(tab, full);
    await browse(tab, tab.cwd, { fresh: true });
  });
}

function chmodEntry(tab, e, full) {
  return guarded(tab, 'Permissions', async () => {
    const val = await ask('Permissions (octal) for ' + e.name, e.mode.toString(8).padStart(3, '0'));
    if (!val) return;
    if (!/^[0-7]{3,4}$/.test(val)) throw new Error('Use 3-4 octal digits, e.g. 644 or 755');
    await window.api.chmod(tab.sid, full, parseInt(val, 8));
    await browse(tab, tab.cwd, { fresh: true });
  });
}

function deleteEntry(tab, e, full) {
  return guarded(tab, 'Delete', async () => {
    const what = e.isDir ? `folder "${e.name}" and everything in it` : `"${e.name}"`;
    if (!confirm(`Permanently delete ${what} from the server? This cannot be undone.`)) return;
    await window.api.remove(tab.sid, full);
    closeDocsUnder(tab, full);
    await browse(tab, tab.cwd, { fresh: true });
  });
}

/* ---------- transfers ---------- */

function transferStart(tab, text) {
  tab.msgEl.textContent = text;
  tab.cancelBtn.disabled = false;
  tab.cancelBtn.hidden = false;
}

function transferEnd(tab) {
  tab.progEl.hidden = true;
  tab.cancelBtn.hidden = true;
}

function transferDone(tab, verb, r) {
  transferEnd(tab);
  if (!r) tab.msgEl.textContent = 'Cancelled';
  else if (r.cancelled) tab.msgEl.textContent = `Transfer cancelled after ${r.files} file${r.files === 1 ? '' : 's'}; the interrupted file was removed`;
  else tab.msgEl.textContent = `${verb} ${r.files} file${r.files === 1 ? '' : 's'} (${human(r.bytes)})`;
}

function upload(tab, paths) {
  if (!tab.sid) return;
  return guarded(tab, 'Upload', async () => {
    transferStart(tab, 'Uploading...');
    const r = await window.api.upload(tab.sid, tab.cwd, paths);
    transferDone(tab, 'Uploaded', r);
    if (r) await browse(tab, tab.cwd, { fresh: true });
  }).finally(() => transferEnd(tab));
}

function download(tab, remotes) {
  return guarded(tab, 'Download', async () => {
    transferStart(tab, 'Downloading...');
    const r = await window.api.download(tab.sid, remotes);
    transferDone(tab, 'Downloaded', r);
  }).finally(() => transferEnd(tab));
}

window.api.onProgress((id, p) => {
  const tab = bySid.get(id);
  if (!tab) return;
  tab.progEl.hidden = false;
  tab.progEl.value = p.total ? p.done / p.total : 1;
  tab.msgEl.textContent = `${p.name}: ${human(p.done)} / ${human(p.total)}`;
});

/* ---------- editor (Monaco): one tab per open file ---------- */

const baseName = (p) => p.replace(/\/+$/, '').split('/').pop() || p;
const sameStat = (a, b) => Boolean(a) && Boolean(b) && a.size === b.size && a.mtime === b.mtime;
const cleanError = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
let nextTabId = 1;

async function ensureEditor(tab) {
  const monaco = await loadMonaco();
  if (!tab.editor) {
    tab.editor = monaco.editor.create(tab.monacoEl, { theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: false } });
    tab.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile(tab));
  }
  return monaco;
}

const docOf = (tab, path) => tab.docs.find((d) => d.path === path);
const hasShebang = (doc) => Boolean(doc) && doc.model.getValue().startsWith('#!');

function updateEditorBar(tab) {
  const doc = tab.doc;
  tab.editPathEl.textContent = doc ? doc.path + (doc.dirty ? ' ●' : '') : '';
  const executable = doc?.stat ? (doc.stat.mode & 0o111) !== 0 : true;
  tab.execBtn.hidden = !(doc && hasShebang(doc) && !executable);
  if (document.body.classList.contains('editor-max')) tab.fullBtn.setIcon('shrink', 'Exit full screen (Esc)');
  else tab.fullBtn.setIcon('expand', `Full screen editor (${KEYS.fullEditor})`);
}

function renderDocTabs(tab) {
  const strip = tab.docTabsEl;
  strip.textContent = '';
  strip.hidden = tab.docs.length === 0;
  for (const doc of tab.docs) {
    const t = el('div', 'dtab' + (doc === tab.doc ? ' on' : ''));
    t.title = doc.path;
    const close = el('span', 'dclose', '×');
    close.title = 'Close (unsaved changes are asked about first)';
    t.append(el('span', 'dname', baseName(doc.path)), el('span', 'ddot', doc.dirty ? '●' : ''), close);
    t.onclick = () => activateDoc(tab, doc);
    t.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeDoc(tab, doc); } }; // middle click closes
    close.onclick = (e) => { e.stopPropagation(); closeDoc(tab, doc); };
    strip.appendChild(t);
    if (doc === tab.doc) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

async function activateDoc(tab, doc) {
  const monaco = await ensureEditor(tab);
  if (!tab.docs.includes(doc)) return monaco; // closed while we waited; its model is gone
  if (tab.doc && tab.doc !== doc) tab.doc.viewState = tab.editor.saveViewState(); // remember scroll and cursor of the file we leave
  tab.doc = doc;
  tab.editor.setModel(doc.model);
  if (doc.viewState) tab.editor.restoreViewState(doc.viewState);
  tab.editorEl.hidden = false;
  renderDocTabs(tab);
  updateEditorBar(tab);
  refit(tab);
  tab.editor.focus();
  return monaco;
}

function newFile(tab) {
  if (!tab.sid) return;
  return guarded(tab, 'New file', async () => {
    const name = await ask('New file name');
    if (!name) return;
    if (name.includes('/')) throw new Error('Name cannot contain "/"');
    const full = joinPath(tab.cwd, name);
    await window.api.createFile(tab.sid, full); // fails if it already exists
    await browse(tab, tab.cwd, { fresh: true });
    await openFile(tab, full);
  });
}

/**
 * Open a file in its own editor tab (or switch to its tab if it is already open). With `force`, load it again from the
 * server into the same tab, discarding what is in the editor.
 */
async function openFile(tab, path, { force = false } = {}) {
  let doc = docOf(tab, path);
  if (doc && !force) { await activateDoc(tab, doc); return true; }
  try {
    const { content, stat } = await window.api.openFile(tab.sid, path);
    const monaco = await ensureEditor(tab);
    if (doc) {
      const position = tab.doc === doc ? tab.editor.getPosition() : null;
      clearTimeout(doc.autoTimer);
      doc.model.setValue(content);
      if (position) tab.editor.setPosition(position);
    } else {
      doc = { path, stat, dirty: false, autoPaused: false, autoTimer: null, saving: false, viewState: null };
      // The model's address includes this connection's id: Monaco keeps every model in one registry, so the same path on
      // two servers would otherwise collide.
      doc.model = monaco.editor.createModel(content, undefined, monaco.Uri.from({ scheme: 'file', authority: 'conn' + tab.id, path }));
      doc.model.onDidChangeContent(() => {
        if (doc.loading) return;
        doc.dirty = true;
        if (tab.doc === doc) updateEditorBar(tab);
        renderDocTabs(tab);
        scheduleAutoSave(tab, doc);
      });
      tab.docs.push(doc);
    }
    doc.stat = stat;
    doc.dirty = false;
    doc.autoPaused = false;
    await activateDoc(tab, doc);
    return true;
  } catch (err) {
    tab.msgEl.textContent = cleanError(err);
    return false;
  }
}

/** Replace a file's contents with the server's, without switching to its tab. */
async function reloadDocInPlace(tab, doc) {
  const { content, stat } = await window.api.openFile(tab.sid, doc.path);
  clearTimeout(doc.autoTimer);
  doc.loading = true; // setValue is not a user edit
  doc.model.setValue(content);
  doc.loading = false;
  doc.stat = stat;
  doc.dirty = false;
  doc.autoPaused = false;
  renderDocTabs(tab);
  if (tab.doc === doc) updateEditorBar(tab);
}

function reloadFile(tab) {
  const doc = tab.doc;
  if (!doc) return;
  if (doc.dirty && !confirm('Discard your unsaved changes and reload ' + doc.path + ' from the server?')) return;
  return reloadDocInPlace(tab, doc).catch((err) => { tab.msgEl.textContent = cleanError(err); });
}

function scheduleAutoSave(tab, doc = tab.doc) {
  if (!doc) return;
  clearTimeout(doc.autoTimer);
  if (!tab.autoBox.checked || doc.autoPaused) return;
  doc.autoTimer = setTimeout(() => saveFile(tab, { auto: true, doc }), 1500);
}

async function saveFile(tab, { auto = false, doc = tab.doc } = {}) {
  if (!doc || doc.saving || !tab.sid) return;
  doc.saving = true;
  const path = doc.path;
  const version = doc.model.getVersionId();
  const content = doc.model.getValue();
  try {
    let res = await window.api.saveFile(tab.sid, path, content, doc.stat, false);
    if (res.conflict) {
      const what = res.stat ? 'changed on the server' : 'deleted on the server';
      if (auto) {
        doc.autoPaused = true; // never overwrite someone else's change unattended
        tab.msgEl.textContent = `Auto-save paused: ${path} was ${what}. Save manually to choose.`;
        return;
      }
      if (!confirm(`${path} was ${what} since you opened it.\n\nOverwrite it with your version? (Cancel keeps editing; use Reload to take the server's version.)`)) return;
      res = await window.api.saveFile(tab.sid, path, content, doc.stat, true);
    }
    if (!tab.docs.includes(doc)) return; // closed while saving
    doc.stat = res.stat;
    doc.autoPaused = false;
    if (doc.model.getVersionId() === version) doc.dirty = false; // keep "unsaved" if typing continued meanwhile
    renderDocTabs(tab);
    if (tab.doc === doc) updateEditorBar(tab);
    tab.msgEl.textContent = (auto ? 'Auto-saved ' : 'Saved ') + path;
  } catch (err) {
    tab.msgEl.textContent = 'Save failed: ' + cleanError(err);
  } finally {
    doc.saving = false;
    if (doc.dirty) scheduleAutoSave(tab, doc);
  }
}

async function makeExecutable(tab) {
  const doc = tab.doc;
  if (!doc || !doc.stat) return;
  await guarded(tab, 'Make executable', async () => {
    const mode = doc.stat.mode;
    await window.api.chmod(tab.sid, doc.path, mode | ((mode & 0o444) >> 2)); // +x wherever there is +r
    doc.stat = await window.api.stat(tab.sid, doc.path);
    if (tab.doc === doc) updateEditorBar(tab);
    tab.msgEl.textContent = 'Made ' + doc.path + ' executable (' + (doc.stat.mode & 0o777).toString(8) + ')';
  });
}

/** When the window or tab regains focus, notice edits made on the server to any open file. */
async function checkExternalChange(tab) {
  if (!tab || !tab.sid) return;
  await Promise.all(tab.docs.map(async (doc) => {
    if (doc.saving) return;
    try {
      const cur = await window.api.stat(tab.sid, doc.path);
      if (sameStat(cur, doc.stat)) return;
      if (!cur) { tab.msgEl.textContent = doc.path + ' was deleted on the server'; return; }
      if (!doc.dirty) {
        await reloadDocInPlace(tab, doc);
        tab.msgEl.textContent = 'Reloaded ' + doc.path + ': it changed on the server';
      } else {
        tab.msgEl.textContent = doc.path + ' changed on the server while you have unsaved edits; saving will ask before overwriting';
      }
    } catch { /* connection may be gone */ }
  }));
}
window.addEventListener('focus', () => checkExternalChange(active));

/** Close one open file. Returns false if the user kept it because of unsaved changes. */
function closeDoc(tab, doc, force = false) {
  if (!doc || !tab.docs.includes(doc)) return true;
  if (!force && doc.dirty && !confirm('Discard unsaved changes in ' + doc.path + '?')) return false;
  clearTimeout(doc.autoTimer);
  const i = tab.docs.indexOf(doc);
  tab.docs.splice(i, 1);
  if (tab.doc === doc) {
    tab.doc = null;
    const next = tab.docs[i] || tab.docs[i - 1];
    if (next) activateDoc(tab, next);
    else {
      tab.editor?.setModel(null);
      tab.editorEl.hidden = true;
      setFullEditor(false); // nothing left to show full screen
    }
  }
  doc.model.dispose();
  renderDocTabs(tab);
  updateEditorBar(tab);
  refit(tab);
  return true;
}

/** Close every open file at once (disconnects, "close all"). Nothing is activated on the way, so nothing can reappear. */
function closeEditor(tab, force = false) {
  const dirty = tab.docs.filter((d) => d.dirty);
  if (!force && dirty.length && !confirm(`Discard unsaved changes in ${dirty.length} file${dirty.length === 1 ? '' : 's'}?`)) return;
  const docs = tab.docs;
  tab.docs = [];
  tab.doc = null;
  tab.editor?.setModel(null);
  for (const doc of docs) {
    clearTimeout(doc.autoTimer);
    doc.model.dispose();
  }
  tab.editorEl.hidden = true;
  setFullEditor(false);
  renderDocTabs(tab);
  updateEditorBar(tab);
  refit(tab);
}

/** Files that were renamed, moved or deleted on the server: their editor tabs no longer mean anything. */
function closeDocsUnder(tab, path) {
  for (const doc of [...tab.docs]) if (doc.path === path || doc.path.startsWith(path + '/')) closeDoc(tab, doc, true);
}

/* ---------- layout: show/hide the left panels, full-screen editor ---------- */

const layout = (() => { try { return { sessions: true, files: true, ...JSON.parse(readPref('layout') || '{}') }; } catch { return { sessions: true, files: true }; } })();

function applyLayout() {
  document.body.classList.toggle('hide-sessions', !layout.sessions);
  document.body.classList.toggle('hide-files', !layout.files);
  $('tglSessions').classList.toggle('on', layout.sessions);
  $('tglFiles').classList.toggle('on', layout.files);
  writePref('layout', JSON.stringify({ sessions: layout.sessions, files: layout.files }));
  // The terminals just got wider or narrower: let them (and the remote shells) know.
  afterLayout(() => { for (const t of tabs) refit(t); });
}
function toggleSessions() { layout.sessions = !layout.sessions; applyLayout(); }
function toggleFiles() { layout.files = !layout.files; applyLayout(); }

/** Give the editor the whole window: hides the sidebar, the file panel and the terminals until turned off. */
function setFullEditor(on) {
  document.body.classList.toggle('editor-max', on);
  for (const t of tabs) updateEditorBar(t);
  afterLayout(() => { for (const t of tabs) { refit(t); t.editor?.layout(); } });
}
function toggleFullEditor() {
  const on = document.body.classList.contains('editor-max');
  if (!on && !active?.doc) { note('Open a file first'); return; }
  setFullEditor(!on);
}

$('tglSessions').onclick = toggleSessions;
$('tglFiles').onclick = toggleFiles;
window.addEventListener('keydown', (e) => {
  // Escape leaves full screen when nothing inside the editor (find box, suggestions) used it first.
  if (e.key === 'Escape' && document.body.classList.contains('editor-max') && !e.defaultPrevented) setFullEditor(false);
});
window.api.onToggle((what) => {
  if (what === 'sessions') toggleSessions();
  else if (what === 'files') toggleFiles();
  else if (what === 'editor-full') toggleFullEditor();
});
applyLayout();

/* ---------- connecting ---------- */

/** The message shown in place of the terminal in a files-only session. */
function sftpMessage(tab, head, body, bad = false) {
  tab.emptyHead.textContent = head;
  tab.emptyBody.textContent = body || '';
  tab.emptyEl.classList.toggle('bad', bad);
}

async function connect(input, title) {
  const tab = createTab(title);
  tab.msgEl.textContent = 'Connecting...';
  const saved = input.profileId ? profiles.find((p) => p.id === input.profileId) : null;
  // "sftp" = files and editor only: the connection is made as usual but no remote shell is ever opened.
  tab.kind = (saved ? saved.kind : input.kind) === 'sftp' ? 'sftp' : 'ssh';
  if (tab.kind === 'sftp') {
    tab.pane.classList.add('sftp');
    tab.header.classList.add('sftp');
    sftpMessage(tab, 'Connecting…');
  }
  tab.termOverride = (saved ? saved.terminal : input.terminal) || null;
  const startDir = (saved ? saved.startupDir : input.startupDir) || null;
  for (const pane of tab.panes) applyPrefsToPane(tab, pane);
  let attempt = input;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const res = await window.api.connect({ ...attempt, title });
      tab.sid = res.id;
      bySid.set(res.id, tab);
      tab.msgEl.textContent = 'Connected';
      openStartFolder(tab, startDir, res.home);
      if (tab.kind === 'sftp') {
        sftpMessage(tab, 'Files only', IS_MAC ? 'Pick a file on the left to edit it. Drag files from Finder onto the list to upload them, or right-click for more.' : 'Pick a file on the left to edit it. Drag files from File Explorer onto the list to upload them, or right-click for more.');
        return;
      }
      await addPane(tab);
      return;
    } catch (err) {
      const text = String(err.message || err);
      const m = /NEEDS_SECRET:(passphrase)(?::([^\n]*))?/.exec(text);
      if (!m) return connectFailed(tab, text.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
      const what = 'Key passphrase';
      tab.msgEl.textContent = 'Waiting for ' + what.toLowerCase();
      const secret = await ask(`${m[2] ? m[2] + '. ' : ''}${what} for ${title}`, '', { secret: true });
      if (!secret) return connectFailed(tab, 'Cancelled');
      attempt = { ...input, secret };
    }
  }
  connectFailed(tab, 'Authentication failed');
}

/** Show the session's start-in folder in the file panel, or the home folder if that is missing or not given. */
async function openStartFolder(tab, startDir, home) {
  if (startDir) {
    await browse(tab, startDir);
    if (tab.cwd === startDir) return;
  }
  browse(tab, home);
}

async function connectFailed(tab, message) {
  tab.msgEl.textContent = 'Failed: ' + message;
  if (tab.kind === 'sftp') { sftpMessage(tab, 'Connection failed', message, true); return; }
  const pane = tab.panes[0] || (await addPane(tab, { shell: false }));
  pane.term.write('\r\n\x1b[31mConnection failed:\x1b[0m ' + message + '\r\n');
}

// The server is asking for a password (or a one-time code) in the middle of logging in. One prompt at a time.
let promptChain = Promise.resolve();
window.api.onNeedSecret((q) => {
  promptChain = promptChain.then(async () => {
    const value = await ask(`${q.previousFailed ? 'Authentication failed. ' : ''}${q.label} for ${q.title}`, '', { secret: q.secret });
    window.api.replySecret(q.reqId, value);
  });
});

window.api.onData((id, shellId, d) => {
  const { pane } = paneByShell(id, shellId);
  pane?.term.write(d);
});
window.api.onShellClosed((id, shellId) => {
  const { tab, pane } = paneByShell(id, shellId);
  if (tab && pane && tab.panes.length > 1) removePane(tab, pane);
});
window.api.onClosed((id) => {
  const tab = bySid.get(id);
  if (!tab) return;
  tab.msgEl.textContent = 'Disconnected';
  tab.sid = null;
  bySid.delete(id);
});
window.addEventListener('resize', () => active && refit(active));

/* ---------- saved sessions ---------- */

let profiles = [];

function collapsedFolders() {
  try { return new Set(JSON.parse(localStorage.getItem('tavrix.collapsed') || '[]')); } catch { return new Set(); }
}
function toggleFolder(name) {
  const set = collapsedFolders();
  set.has(name) ? set.delete(name) : set.add(name);
  writePref('collapsed', JSON.stringify([...set]));
  renderSessions();
}

function sessionRow(p, indent) {
  const li = el('li', indent ? 'indent' : '');
  const info = el('div');
  const nameRow = el('div', '', p.name);
  if (p.kind === 'sftp') {
    const badge = el('span', 'kind', 'SFTP');
    badge.title = 'Files and editor only, no terminal';
    nameRow.append(' ', badge);
  }
  info.append(nameRow);
  const via = p.jumpHostId ? ' via ' + (profiles.find((x) => x.id === p.jumpHostId)?.name ?? '?') : '';
  info.append(el('small', '', `${p.username}@${p.host}${p.port !== 22 ? ':' + p.port : ''}${via}`));
  const tools = el('span', 'tools');
  const edit = el('button', 'x', '✎');
  edit.title = 'Edit saved session';
  edit.onclick = (e) => { e.stopPropagation(); openSessionDialog(p); };
  const x = el('button', 'x', '×');
  x.title = 'Delete saved session';
  x.onclick = async (e) => {
    e.stopPropagation();
    const users = profiles.filter((o) => o.jumpHostId === p.id).map((o) => o.name);
    const warn = users.length ? `\n\n${users.join(', ')} use it as a jump host and will stop working.` : '';
    if (confirm('Delete saved session "' + p.name + '"?' + warn)) {
      await window.api.profiles.remove(p.id);
      loadProfiles();
    }
  };
  tools.append(edit, x);
  li.append(info, tools);
  li.onclick = () => connect({ profileId: p.id }, p.name);
  return li;
}

function renderSessions() {
  const ul = $('sessionList');
  ul.textContent = '';
  const collapsed = collapsedFolders();
  const loose = profiles.filter((p) => !p.folder);
  for (const p of loose) ul.appendChild(sessionRow(p, false));
  const names = [...new Set(profiles.filter((p) => p.folder).map((p) => p.folder))].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const members = profiles.filter((p) => p.folder === name);
    const head = el('li', 'folder', (collapsed.has(name) ? '▸ ' : '▾ ') + name);
    head.append(el('small', '', String(members.length)));
    head.onclick = () => toggleFolder(name);
    ul.appendChild(head);
    if (!collapsed.has(name)) for (const p of members) ul.appendChild(sessionRow(p, true));
  }
}

async function loadProfiles() {
  profiles = (await window.api.profiles.list()).sort((a, b) => a.name.localeCompare(b.name));
  renderSessions();
}

$('import').onclick = async () => {
  const r = await window.api.profiles.importSshConfig();
  let msg = `Imported ${r.added}, skipped ${r.skipped} existing.`;
  if (r.jumpsLinked) msg += ` Linked ${r.jumpsLinked} ProxyJump.`;
  if (r.jumpsUnresolved) msg += ` ${r.jumpsUnresolved} ProxyJump not linked (only single-hop aliases are supported).`;
  note(msg);
  loadProfiles();
};

/* ---------- new / edit connection dialog ---------- */

terminalFields($('f-term'), 'ft', { withDefault: true });

function showSessionTab(name) {
  for (const b of $('sTabs').children) b.classList.toggle('on', b.dataset.tab === name);
  for (const pane of $('dlg').querySelectorAll('.tabpane')) pane.hidden = pane.dataset.pane !== name;
}
$('sTabs').onclick = (e) => { if (e.target.dataset.tab) showSessionTab(e.target.dataset.tab); };
// A required field on another tab would block submit silently; jump to the tab that has the problem.
$('form').addEventListener('invalid', (e) => { const pane = e.target.closest('.tabpane'); if (pane) showSessionTab(pane.dataset.pane); }, true);

/** Files-only sessions have no terminal, so the Terminal tab and the startup command do not apply. */
function syncKindFields() {
  const sftp = $('f-kind').value === 'sftp';
  $('sTabs').querySelector('[data-tab="term"]').hidden = sftp;
  $('f-scmd-label').hidden = sftp;
  $('f-sdir-lab').textContent = sftp ? 'Open this folder first' : 'Start in folder (typed as cd in the first terminal)';
  if (!$('f-id').value) $('dlgTitle').textContent = sftp ? 'New SFTP session' : 'New connection';
}
$('f-kind').onchange = syncKindFields;

function openSessionDialog(p, preset = {}) {
  $('form').reset();
  showSessionTab('basic');
  const jump = $('f-jump');
  jump.textContent = '';
  jump.append(new Option('None', ''));
  for (const o of profiles) if (!p || o.id !== p.id) jump.append(new Option(`${o.name} (${o.username}@${o.host})`, o.id));
  const dl = $('folderList');
  dl.textContent = '';
  for (const f of new Set(profiles.map((o) => o.folder).filter(Boolean))) dl.append(new Option(f));
  $('f-id').value = p ? p.id : '';
  $('f-kind').value = p?.kind === 'sftp' || (!p && preset.kind === 'sftp') ? 'sftp' : 'ssh';
  $('dlgTitle').textContent = p ? 'Edit session' : 'New connection';
  $('f-go').textContent = p ? 'Save' : 'Connect';
  $('f-save').checked = true;
  $('f-save').parentElement.hidden = Boolean(p);
  $('f-name').value = p ? p.name : '';
  $('f-host').value = p ? p.host : '';
  $('f-port').value = p ? p.port : 22;
  $('f-user').value = p ? p.username : '';
  $('f-key').value = p?.privateKeyPath ?? '';
  showKeyHint();
  $('f-pass').placeholder = p?.hasSecret ? 'Saved; leave blank to keep it' : 'Password (or key passphrase)';
  jump.value = p?.jumpHostId ?? '';
  $('f-keepalive').value = p?.keepAliveSec ?? '';
  $('f-compress').value = p?.compression === undefined ? '' : String(p.compression);
  $('f-timeout').value = p?.connectTimeoutSec ?? '';
  $('f-sdir').value = p?.startupDir ?? '';
  $('f-scmd').value = p?.startupCommand ?? '';
  $('f-folder').value = p?.folder ?? '';
  fillTerminalFields('ft', p?.terminal);
  syncKindFields();
  $('dlg').showModal();
  $('f-host').focus();
}

function readSessionForm() {
  const num = (id) => ($(id).value.trim() === '' ? undefined : Number($(id).value));
  const text = (id) => $(id).value.trim() || undefined;
  const host = $('f-host').value.trim();
  const username = $('f-user').value.trim();
  return {
    id: $('f-id').value || undefined,
    name: $('f-name').value.trim() || `${username || 'me'}@${host}`,
    host, username,
    port: Number($('f-port').value) || 22,
    privateKeyPath: text('f-key'),
    jumpHostId: $('f-jump').value || undefined,
    folder: text('f-folder'),
    kind: $('f-kind').value === 'sftp' ? 'sftp' : undefined,
    keepAliveSec: num('f-keepalive'),
    compression: $('f-compress').value === '' ? undefined : $('f-compress').value === 'true',
    connectTimeoutSec: num('f-timeout'),
    startupDir: text('f-sdir'),
    startupCommand: text('f-scmd'),
    terminal: readTerminalFields('ft'),
  };
}

/** Say what the chosen key file is, so a wrong pick (a .pub file, a random file) is caught before connecting. */
async function showKeyHint() {
  const hint = $('f-keyhint');
  const path = $('f-key').value.trim();
  hint.className = 'hint';
  hint.textContent = '';
  if (!path) return;
  const info = await window.api.keys.inspect(path);
  if ($('f-key').value.trim() !== path) return; // the field changed while we were asking
  if (info.kind === 'private') { hint.className = 'hint good'; hint.textContent = `✓ ${info.type} private key`; }
  else if (info.kind === 'private-encrypted') { hint.className = 'hint good'; hint.textContent = '✓ Encrypted private key: you will be asked for its passphrase'; }
  else if (info.kind === 'public') { hint.className = 'hint warn'; hint.textContent = 'This is a public key (.pub). Choose the matching private key file.'; }
  else { hint.className = 'hint bad'; hint.textContent = info.message; }
}

function applyPickedKey(path) {
  if (!path) return;
  $('f-key').value = path;
  showKeyHint();
}
$('f-keybrowse').onclick = async () => applyPickedKey(await window.api.keys.pick());
$('f-key').addEventListener('change', showKeyHint);

$('new').onclick = () => openSessionDialog(null);
$('newSftp').onclick = () => openSessionDialog(null, { kind: 'sftp' });
$('f-cancel').onclick = () => $('dlg').close();
$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  const form = readSessionForm();
  const password = $('f-pass').value;
  const editing = form.id;
  $('dlg').close();
  try {
    if (editing || $('f-save').checked) {
      const id = await window.api.profiles.save(form, password || undefined);
      await loadProfiles();
      if (!editing) connect({ profileId: id }, form.name);
    } else {
      connect({ ...form, password }, form.name);
    }
  } catch (err) {
    note('Could not save: ' + String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  }
};

/* ---------- global settings ---------- */

terminalFields($('set-term'), 'st', { withDefault: false });

function fillSettings(s) {
  fillTerminalFields('st', s.terminal);
  $('set-keepalive').value = s.connection.keepAliveSec;
  $('set-compress').checked = s.connection.compression;
  $('set-timeout').value = s.connection.connectTimeoutSec;
}

function openSettings() {
  fillSettings(settings);
  $('settings').showModal();
}
window.api.settings.onOpen(openSettings);
$('gear').onclick = openSettings;
$('set-cancel').onclick = () => $('settings').close();
$('set-reset').onclick = () => { if (settings.defaults) fillSettings(settings.defaults); };
$('setForm').onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    settings = { ...settings, ...(await window.api.settings.set({
      terminal: readTerminalFields('st'),
      connection: { keepAliveSec: Number($('set-keepalive').value), compression: $('set-compress').checked, connectTimeoutSec: Number($('set-timeout').value) },
    })) };
    $('settings').close();
    applyPrefsToAll();
  } catch (err) {
    note('Could not save settings: ' + String(err.message || err));
  }
};

/* ---------- tunnels ---------- */

let tunnelTab = null;

async function refreshTunnels() {
  const ul = $('fwdList');
  ul.textContent = '';
  const list = tunnelTab?.sid ? await window.api.forwards.list(tunnelTab.sid) : [];
  if (!list.length) ul.appendChild(el('li', 'empty', 'No tunnels running on this connection'));
  for (const f of list) {
    const li = el('li');
    li.append(el('span', '', f.description));
    const stop = el('button', '', 'Stop');
    stop.onclick = async () => {
      await window.api.forwards.stop(tunnelTab.sid, f.id);
      refreshTunnels();
    };
    li.append(stop);
    ul.appendChild(li);
  }
}

function syncTunnelForm() {
  const dynamic = $('fwdKind').value === 'dynamic';
  $('fwdDest').hidden = dynamic;
  $('fwdBindHost').title = $('fwdKind').value === 'remote' ? 'Address to listen on at the server' : 'Address to listen on on this Mac';
}

function openTunnels(tab) {
  if (!tab.sid) { tab.msgEl.textContent = 'Connect first'; return; }
  tunnelTab = tab;
  $('fwdMsg').textContent = '';
  syncTunnelForm();
  refreshTunnels();
  $('fwd').showModal();
}

$('fwdKind').onchange = syncTunnelForm;
$('fwdClose').onclick = () => $('fwd').close();
$('fwdForm').onsubmit = async (ev) => {
  ev.preventDefault();
  $('fwdMsg').textContent = '';
  const kind = $('fwdKind').value;
  try {
    await window.api.forwards.start(tunnelTab.sid, {
      kind,
      bindHost: $('fwdBindHost').value.trim() || '127.0.0.1',
      bindPort: Number($('fwdBindPort').value || 0),
      destHost: $('fwdDestHost').value.trim(),
      destPort: Number($('fwdDestPort').value || 0),
    });
    await refreshTunnels();
  } catch (err) {
    $('fwdMsg').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
};

/* ---------- snippets ---------- */

let snippets = [];

async function loadSnippets() {
  snippets = (await window.api.snippets.list()).sort((a, b) => a.name.localeCompare(b.name));
  const ul = $('snippetList');
  ul.textContent = '';
  if (!snippets.length) ul.appendChild(el('li', '', '')).append(el('small', '', 'Save commands you type often'));
  for (const sn of snippets) {
    const li = el('li');
    li.title = sn.text;
    li.append(el('span', '', sn.name));
    const tools = el('span', 'tools');
    const edit = el('button', 'x', '✎');
    edit.onclick = (e) => { e.stopPropagation(); openSnippetDialog(sn); };
    const del = el('button', 'x', '×');
    del.onclick = async (e) => {
      e.stopPropagation();
      if (confirm('Delete snippet "' + sn.name + '"?')) { await window.api.snippets.remove(sn.id); loadSnippets(); }
    };
    tools.append(edit, del);
    li.append(tools);
    li.onclick = () => insertSnippet(sn);
    ul.appendChild(li);
  }
}

/**
 * Send a snippet to the focused terminal. Multi-line text goes in as a bracketed paste so the shell
 * shows it for review instead of executing every line but the last; Enter is added only if the snippet asks for it.
 */
function insertSnippet(sn) {
  const tab = active;
  const pane = tab?.focused;
  if (!tab?.sid || !pane?.shellId) { note('Open a connected terminal first'); return; }
  const body = sn.text.replace(/\r?\n$/, '').replace(/\r?\n/g, '\r');
  const text = body.includes('\r') ? '\x1b[200~' + body + '\x1b[201~' : body;
  window.api.write(tab.sid, pane.shellId, text + (sn.run ? '\r' : ''));
  pane.term.focus();
}

function openSnippetDialog(sn) {
  $('snipForm').reset();
  $('s-id').value = sn?.id ?? '';
  $('snipTitle').textContent = sn ? 'Edit snippet' : 'New snippet';
  $('s-name').value = sn?.name ?? '';
  $('s-text').value = sn?.text ?? '';
  $('s-run').checked = Boolean(sn?.run);
  $('snip').showModal();
  $('s-name').focus();
}

$('newSnippet').onclick = () => openSnippetDialog(null);
$('s-cancel').onclick = () => $('snip').close();
$('snipForm').onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    await window.api.snippets.save({ id: $('s-id').value || undefined, name: $('s-name').value.trim(), text: $('s-text').value, run: $('s-run').checked });
    $('snip').close();
    loadSnippets();
  } catch (err) {
    note('Could not save snippet: ' + (err.message || err));
  }
};

/* ---------- manual and quick tour ---------- */

function openManual() {
  const frame = $('manualFrame');
  if (!frame.getAttribute('src')) frame.src = 'manual.html'; // loaded on first use
  if (!$('manual').open) $('manual').showModal();
}
$('helpManual').onclick = openManual;
$('manClose').onclick = () => $('manual').close();
$('manGithub').onclick = () => window.api.help.open('manual');
$('manTour').onclick = () => { $('manual').close(); startTour(0); };
window.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); openManual(); } });

const TOUR_STEPS = [
  { title: 'Welcome to Tavrix', body: 'A terminal, a file manager and a code editor for your servers, in one window. This short tour shows where things are. Close it any time; you can bring it back from the Help menu.' },
  { target: '#new', title: 'Add a server', body: 'Click + to enter the host and username, then a password, or choose a private key with Browse…. Choose SFTP instead of SSH for a files-only session with no terminal. Sessions are saved, and secrets are stored encrypted by your system.' },
  { target: '#sessionList', fallback: '#sessions', title: 'Your sessions', body: 'Saved sessions appear here. Click one to connect, ✎ to edit it. Put them in folders from the session’s Bookmark tab. Import brings in hosts from ~/.ssh/config.' },
  { target: '#layoutTools', title: 'Show, hide and resize', body: 'These icons show or hide the sessions sidebar and the file panel (' + KEYS.sessions + ' and ' + KEYS.files + '). Drag any thin divider to resize a panel, or double-click it to reset.' },
  { target: '#newSnippet', title: 'Snippets', body: 'Save commands you type often and insert them with one click. Multi-line snippets are pasted, not run, until you press Enter.' },
  { target: '#gear', title: 'Settings', body: 'Terminal font, theme, scrollback, keep-alive and more. A session can override any of them in its own Terminal and Advanced tabs. Shortcut: ' + KEYS.settings },
  { title: 'Once you are connected', bullets: [
    'Click a folder to open it; double-click a file to edit it.',
    'Right-click a file for download, rename, permissions and delete.',
    `Drag files from ${IS_MAC ? 'Finder' : 'File Explorer'} onto the file panel to upload.`,
    `Open several files: each gets its own editor tab. ${KEYS.save} saves.`,
    'Split the terminal, or open Tunnels for port forwarding, from the bar at the bottom.',
    `${KEYS.fullEditor} gives the editor the whole window; Esc brings the rest back.`,
  ] },
  { target: '#helpManual', title: 'Help is one click away', body: 'Manual opens the full documentation right here, with a link to the same pages on GitHub. Quick Tour is in the Help menu if you want to see this again. Enjoy!' },
];
let tourIndex = 0;
let tourReturnFocus = null;

function tourElement(step) {
  for (const sel of [step.target, step.fallback]) {
    const e = sel && document.querySelector(sel);
    if (e && e.offsetParent !== null) return e; // present and visible (a hidden sidebar has no box)
  }
  return null;
}

function placeTour() {
  const step = TOUR_STEPS[tourIndex];
  const target = tourElement(step);
  const card = $('tourCard');
  const hole = $('tourHole');
  $('tour').classList.toggle('centered', !target);
  const margin = 12;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  if (!target) {
    card.style.left = Math.max(margin, (innerWidth - cw) / 2) + 'px';
    card.style.top = Math.max(margin, (innerHeight - ch) / 2) + 'px';
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 6;
  Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  // Prefer the right of the target, then below it; always stay inside the window.
  let left = r.right + pad + 14;
  let top = r.top;
  if (left + cw > innerWidth - margin) { left = r.left; top = r.bottom + pad + 14; }
  if (top + ch > innerHeight - margin) top = Math.max(margin, innerHeight - ch - margin);
  card.style.left = clamp(left, margin, Math.max(margin, innerWidth - cw - margin)) + 'px';
  card.style.top = clamp(top, margin, Math.max(margin, innerHeight - ch - margin)) + 'px';
}

function showTourStep(i) {
  tourIndex = clamp(i, 0, TOUR_STEPS.length - 1);
  const step = TOUR_STEPS[tourIndex];
  $('tourTitle').textContent = step.title;
  const body = $('tourBody');
  body.textContent = '';
  if (step.body) body.textContent = step.body;
  if (step.bullets) {
    const ul = el('ul');
    for (const b of step.bullets) ul.appendChild(el('li', '', b));
    body.appendChild(ul);
  }
  const dots = $('tourDots');
  dots.textContent = '';
  TOUR_STEPS.forEach((_, n) => dots.appendChild(el('i', n === tourIndex ? 'on' : '')));
  const last = tourIndex === TOUR_STEPS.length - 1;
  $('tourBack').disabled = tourIndex === 0;
  $('tourNext').textContent = last ? 'Done' : 'Next';
  $('tourSkip').hidden = last;
  placeTour();
  $('tourNext').focus();
}

function startTour(from = 0) {
  if (!$('tour').hidden) return;
  tourReturnFocus = document.activeElement;
  $('tour').hidden = false;
  showTourStep(from);
}

function endTour() {
  if ($('tour').hidden) return;
  $('tour').hidden = true;
  window.api.tour.done(); // remembered whether it was finished or skipped, so it does not come back by itself
  tourReturnFocus?.focus?.();
}

$('tourNext').onclick = () => (tourIndex >= TOUR_STEPS.length - 1 ? endTour() : showTourStep(tourIndex + 1));
$('tourBack').onclick = () => showTourStep(tourIndex - 1);
$('tourSkip').onclick = endTour;
$('tourClose').onclick = endTour;
window.addEventListener('resize', () => { if (!$('tour').hidden) placeTour(); });
window.addEventListener('keydown', (e) => {
  if ($('tour').hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); }
  else if (e.key === 'ArrowRight') $('tourNext').click();
  else if (e.key === 'ArrowLeft' && !$('tourBack').disabled) $('tourBack').click();
}, true);
window.api.onHelp((what) => (what === 'tour' ? startTour(0) : openManual()));

/* ---------- update notice ---------- */

window.api.update.onAvailable((info) => {
  $('updateMsg').textContent = `Tavrix ${info.latest} is available (you have ${info.current}).`;
  $('update').hidden = false;
});
$('updDownload').onclick = () => window.api.update.open('download');
$('updNotes').onclick = () => window.api.update.open('notes');
$('updLater').onclick = async () => { await window.api.update.later(); $('update').hidden = true; };
$('updSkip').onclick = async () => { await window.api.update.skip(); $('update').hidden = true; };

loadProfiles();
loadSnippets();
