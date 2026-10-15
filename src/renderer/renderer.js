const $ = (id) => document.getElementById(id);
const tabs = [];
let active = null;
const bySid = new Map();

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
    let result = null;
    $('askForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('askInput').value;
      result = secret ? v : v.trim(); // passwords may legitimately start or end with spaces
      dlg.close();
    };
    $('askCancel').onclick = () => dlg.close();
    dlg.onclose = () => resolve(result || null);
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
  terminal: { fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: 13, theme: 'tavrix-dark', scrollback: 5000, cursorStyle: 'block', cursorBlink: true, copyOnSelect: false },
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

const FONT_CHOICES = ['Menlo', 'Monaco', 'SF Mono', 'Courier New', 'JetBrains Mono', 'Fira Code', 'Source Code Pro'];

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

window.api.settings.get().then((s) => { settings = s; applyPrefsToAll(); });
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
  tab.editorEl = el('div', 'editor');
  tab.editorEl.hidden = true;
  const bar = el('div', 'editbar');
  tab.editPathEl = el('span', 'editpath');
  const autoLabel = el('label', 'auto');
  tab.autoBox = el('input');
  tab.autoBox.type = 'checkbox';
  tab.autoBox.checked = readPref('autosave') === '1';
  tab.autoBox.onchange = () => { writePref('autosave', tab.autoBox.checked ? '1' : '0'); tab.autoPaused = false; if (tab.autoBox.checked) scheduleAutoSave(tab); };
  autoLabel.append(tab.autoBox, ' Auto-save');
  autoLabel.title = 'Save automatically 1.5 s after you stop typing';
  tab.execBtn = el('button', '', 'Make executable');
  tab.execBtn.hidden = true;
  tab.execBtn.title = 'chmod +x: this file starts with #! but is not executable';
  tab.execBtn.onclick = () => makeExecutable(tab);
  const reload = el('button', '', 'Reload');
  reload.title = 'Discard the editor contents and load the file from the server again';
  reload.onclick = () => reloadFile(tab);
  const save = el('button', '', 'Save');
  const closeEdit = el('button', '', 'Close');
  bar.append(tab.editPathEl, autoLabel, tab.execBtn, reload, save, closeEdit);
  tab.monacoEl = el('div', 'monaco');
  tab.editorEl.append(bar, tab.monacoEl);
  tab.statusEl = el('div', 'status');
  tab.msgEl = el('span', 'msg');
  tab.progEl = el('progress');
  tab.progEl.hidden = true;
  tab.progEl.max = 1;
  tab.cancelBtn = el('button', '', 'Cancel');
  tab.cancelBtn.hidden = true;
  tab.cancelBtn.onclick = () => { tab.cancelBtn.disabled = true; window.api.cancelTransfer(tab.sid); };
  const sbtn = (label, title, fn) => { const b = el('button', 'sb', label); b.title = title; b.onclick = fn; return b; };
  tab.statusEl.append(
    tab.msgEl, tab.progEl, tab.cancelBtn,
    sbtn('Split →', 'Split the terminal side by side', () => splitPane(tab, 'row')),
    sbtn('Split ↓', 'Split the terminal top and bottom', () => splitPane(tab, 'col')),
    sbtn('Close pane', 'Close the focused terminal pane', () => closePane(tab, tab.focused)),
    sbtn('Tunnels', 'Port forwarding', () => openTunnels(tab)),
  );
  work.append(tab.termEl, tab.editorEl, tab.statusEl);
  tab.pane.append(aside, work);

  save.onclick = () => saveFile(tab);
  closeEdit.onclick = () => closeEditor(tab);

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
  pane.el.addEventListener('mousedown', () => { tab.focused = pane; });
  pane.term.onData((d) => tab.sid && pane.shellId && window.api.write(tab.sid, pane.shellId, d));
  pane.term.onSelectionChange(() => {
    if (effectivePrefs(tab).copyOnSelect && pane.term.hasSelection()) navigator.clipboard?.writeText(pane.term.getSelection()).catch(() => {});
  });
  tab.panes.push(pane);
  tab.focused = pane;
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
  addPane(tab);
}

function removePane(tab, pane) {
  pane.term.dispose();
  pane.el.remove();
  tab.panes.splice(tab.panes.indexOf(pane), 1);
  if (tab.focused === pane) tab.focused = tab.panes[tab.panes.length - 1] || null;
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
  requestAnimationFrame(() => refit(tab));
  checkExternalChange(tab);
}

function refit(tab) {
  for (const pane of tab.panes) {
    try {
      pane.fit.fit();
      if (tab.sid && pane.shellId) window.api.resize(tab.sid, pane.shellId, pane.term.cols, pane.term.rows);
    } catch { /* pane hidden */ }
  }
}

function closeTab(tab) {
  if (tab.editing && tab.editDirty && !confirm('Discard unsaved changes in ' + tab.editing + '?')) return;
  if (tab.sid) { window.api.disconnect(tab.sid); bySid.delete(tab.sid); }
  clearTimeout(tab.autoTimer);
  tab.editor?.dispose();
  tab.model?.dispose();
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
    if (tab.editing === full) closeEditor(tab, true);
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
    if (tab.editing && (tab.editing === full || tab.editing.startsWith(full + '/'))) closeEditor(tab, true);
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

/* ---------- editor (Monaco) ---------- */

async function ensureEditor(tab) {
  const monaco = await loadMonaco();
  if (!tab.editor) {
    tab.editor = monaco.editor.create(tab.monacoEl, { theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: false } });
    tab.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile(tab));
  }
  return monaco;
}

const sameStat = (a, b) => Boolean(a) && Boolean(b) && a.size === b.size && a.mtime === b.mtime;
const hasShebang = (tab) => tab.model && tab.model.getValue().startsWith('#!');

function updateEditorBar(tab) {
  tab.editPathEl.textContent = tab.editing ? tab.editing + (tab.editDirty ? ' ●' : '') : '';
  const executable = tab.editStat ? (tab.editStat.mode & 0o111) !== 0 : true;
  tab.execBtn.hidden = !(tab.editing && hasShebang(tab) && !executable);
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

async function openFile(tab, path, { force = false } = {}) {
  if (!force && tab.editing === path) return true;
  if (!force && tab.editing && tab.editDirty && !confirm('Discard unsaved changes in ' + tab.editing + '?')) return false;
  try {
    const { content, stat } = await window.api.openFile(tab.sid, path);
    const monaco = await ensureEditor(tab);
    const position = force && tab.editing === path ? tab.editor.getPosition() : null;
    clearTimeout(tab.autoTimer);
    // Swap models in one synchronous step: Monaco refuses a second model for the same URI, so the old one goes first.
    tab.editor.setModel(null);
    tab.model?.dispose();
    tab.model = monaco.editor.createModel(content, undefined, monaco.Uri.from({ scheme: 'file', path }));
    tab.editor.setModel(tab.model);
    if (position) tab.editor.setPosition(position);
    tab.editing = path;
    tab.editStat = stat;
    tab.editDirty = false;
    tab.autoPaused = false;
    tab.model.onDidChangeContent(() => { tab.editDirty = true; updateEditorBar(tab); scheduleAutoSave(tab); });
    tab.editorEl.hidden = false;
    updateEditorBar(tab);
    refit(tab);
    tab.editor.focus();
    return true;
  } catch (err) {
    tab.msgEl.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    return false;
  }
}

function reloadFile(tab) {
  if (!tab.editing) return;
  if (tab.editDirty && !confirm('Discard your unsaved changes and reload ' + tab.editing + ' from the server?')) return;
  return openFile(tab, tab.editing, { force: true });
}

function scheduleAutoSave(tab) {
  clearTimeout(tab.autoTimer);
  if (!tab.autoBox.checked || tab.autoPaused || !tab.editing) return;
  tab.autoTimer = setTimeout(() => saveFile(tab, { auto: true }), 1500);
}

async function saveFile(tab, { auto = false } = {}) {
  if (!tab.editing || tab.saving || !tab.sid) return;
  tab.saving = true;
  const path = tab.editing;
  const version = tab.model.getVersionId();
  const content = tab.model.getValue();
  try {
    let res = await window.api.saveFile(tab.sid, path, content, tab.editStat, false);
    if (res.conflict) {
      const what = res.stat ? 'changed on the server' : 'deleted on the server';
      if (auto) {
        tab.autoPaused = true; // never overwrite someone else's change unattended
        tab.msgEl.textContent = `Auto-save paused: ${path} was ${what}. Save manually to choose.`;
        return;
      }
      if (!confirm(`${path} was ${what} since you opened it.\n\nOverwrite it with your version? (Cancel keeps editing; use Reload to take the server's version.)`)) return;
      res = await window.api.saveFile(tab.sid, path, content, tab.editStat, true);
    }
    if (tab.editing !== path) return; // closed or switched while saving
    tab.editStat = res.stat;
    tab.autoPaused = false;
    if (tab.model.getVersionId() === version) tab.editDirty = false; // keep "unsaved" if typing continued meanwhile
    updateEditorBar(tab);
    tab.msgEl.textContent = (auto ? 'Auto-saved ' : 'Saved ') + path;
  } catch (err) {
    tab.msgEl.textContent = 'Save failed: ' + String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  } finally {
    tab.saving = false;
    if (tab.editDirty) scheduleAutoSave(tab);
  }
}

async function makeExecutable(tab) {
  if (!tab.editing || !tab.editStat) return;
  await guarded(tab, 'Make executable', async () => {
    const mode = tab.editStat.mode;
    await window.api.chmod(tab.sid, tab.editing, mode | ((mode & 0o444) >> 2)); // +x wherever there is +r
    tab.editStat = await window.api.stat(tab.sid, tab.editing);
    updateEditorBar(tab);
    tab.msgEl.textContent = 'Made ' + tab.editing + ' executable (' + (tab.editStat.mode & 0o777).toString(8) + ')';
  });
}

/** When the window or tab regains focus, notice edits made on the server by someone or something else. */
async function checkExternalChange(tab) {
  if (!tab || !tab.sid || !tab.editing || tab.saving) return;
  try {
    const cur = await window.api.stat(tab.sid, tab.editing);
    if (sameStat(cur, tab.editStat)) return;
    if (!cur) { tab.msgEl.textContent = tab.editing + ' was deleted on the server'; return; }
    if (!tab.editDirty) {
      const path = tab.editing;
      if (await openFile(tab, path, { force: true })) tab.msgEl.textContent = 'Reloaded ' + path + ': it changed on the server';
    } else {
      tab.msgEl.textContent = tab.editing + ' changed on the server while you have unsaved edits; saving will ask before overwriting';
    }
  } catch { /* connection may be gone */ }
}
window.addEventListener('focus', () => checkExternalChange(active));

function closeEditor(tab, force = false) {
  if (!force && tab.editDirty && !confirm('Discard unsaved changes?')) return;
  clearTimeout(tab.autoTimer);
  tab.editorEl.hidden = true;
  tab.editing = null;
  tab.editStat = null;
  tab.editDirty = false;
  tab.editor?.setModel(null);
  tab.model?.dispose();
  tab.model = null;
  updateEditorBar(tab);
  refit(tab);
}

/* ---------- connecting ---------- */

async function connect(input, title) {
  const tab = createTab(title);
  tab.msgEl.textContent = 'Connecting...';
  const saved = input.profileId ? profiles.find((p) => p.id === input.profileId) : null;
  tab.termOverride = (saved ? saved.terminal : input.terminal) || null;
  const startDir = (saved ? saved.startupDir : input.startupDir) || null;
  for (const pane of tab.panes) applyPrefsToPane(tab, pane);
  let attempt = input;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const res = await window.api.connect(attempt);
      tab.sid = res.id;
      bySid.set(res.id, tab);
      tab.msgEl.textContent = 'Connected';
      openStartFolder(tab, startDir, res.home);
      await addPane(tab);
      return;
    } catch (err) {
      const text = String(err.message || err);
      const m = /NEEDS_SECRET:(password|passphrase)(?::([^\n]*))?/.exec(text);
      if (!m) return connectFailed(tab, text.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
      const what = m[1] === 'password' ? 'Password' : 'Key passphrase';
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
  const pane = tab.panes[0] || (await addPane(tab, { shell: false }));
  pane.term.write('\r\n\x1b[31mConnection failed:\x1b[0m ' + message + '\r\n');
}

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
  info.append(el('div', '', p.name));
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

function openSessionDialog(p) {
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

/* ---------- update notice ---------- */

window.api.update.onAvailable((info) => {
  $('updateMsg').textContent = `Tavrix ${info.latest} is available (you have ${info.current}).`;
  $('update').hidden = false;
});
$('updDownload').onclick = () => window.api.update.open('download');
$('updNotes').onclick = () => window.api.update.open('notes');
$('updLater').onclick = () => { $('update').hidden = true; };
$('updSkip').onclick = async () => { await window.api.update.skip(); $('update').hidden = true; };

loadProfiles();
loadSnippets();
