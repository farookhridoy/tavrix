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

/* ---------- tabs ---------- */

function createTab(title) {
  const tab = { title, sid: null, cwd: '/', editing: null };

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
  mkBtn('⟳', 'Refresh', () => tab.sid && browse(tab, tab.cwd));
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
      { label: 'Refresh', run: () => browse(tab, tab.cwd) },
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
  pane.term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: true });
  pane.fit = new FitAddon.FitAddon();
  pane.term.loadAddon(pane.fit);
  tab.termEl.appendChild(pane.el);
  pane.term.open(pane.el);
  pane.el.addEventListener('mousedown', () => { tab.focused = pane; });
  pane.term.onData((d) => tab.sid && pane.shellId && window.api.write(tab.sid, pane.shellId, d));
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

async function browse(tab, path) {
  try {
    const items = await window.api.list(tab.sid, path);
    tab.cwd = path;
    tab.cwdEl.textContent = path;
    tab.filesEl.textContent = '';
    if (path !== '/') {
      const up = el('li', '', '📁 ..');
      up.onclick = () => browse(tab, parentPath(path));
      tab.filesEl.appendChild(up);
    }
    for (const e of items) {
      const li = el('li');
      li.append(el('span', '', (e.isDir ? '📁 ' : e.isLink ? '🔗 ' : '📄 ') + e.name), el('small', '', e.isDir ? '' : human(e.size)));
      const full = joinPath(path, e.name);
      li.onclick = () => {
        for (const x of tab.filesEl.children) x.classList.remove('sel');
        li.classList.add('sel');
      };
      li.ondblclick = () => (e.isDir ? browse(tab, full) : openFile(tab, full));
      li.oncontextmenu = (ev) => {
        ev.preventDefault();
        li.onclick();
        showMenu(ev.clientX, ev.clientY, [
          { label: e.isDir ? 'Open folder' : 'Edit', run: () => (e.isDir ? browse(tab, full) : openFile(tab, full)) },
          { label: 'Download…', run: () => download(tab, [full]) },
          '-',
          { label: 'Rename…', run: () => renameEntry(tab, e, full) },
          { label: 'Permissions…', run: () => chmodEntry(tab, e, full) },
          { label: 'Delete', run: () => deleteEntry(tab, e, full) },
        ]);
      };
      tab.filesEl.appendChild(li);
    }
  } catch (err) {
    tab.msgEl.textContent = String(err.message || err);
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
    await browse(tab, tab.cwd);
  });
}

function renameEntry(tab, e, full) {
  return guarded(tab, 'Rename', async () => {
    const name = await ask('Rename ' + e.name, e.name);
    if (!name || name === e.name) return;
    if (name.includes('/')) throw new Error('Name cannot contain "/"');
    await window.api.rename(tab.sid, full, joinPath(tab.cwd, name));
    if (tab.editing === full) closeEditor(tab, true);
    await browse(tab, tab.cwd);
  });
}

function chmodEntry(tab, e, full) {
  return guarded(tab, 'Permissions', async () => {
    const val = await ask('Permissions (octal) for ' + e.name, e.mode.toString(8).padStart(3, '0'));
    if (!val) return;
    if (!/^[0-7]{3,4}$/.test(val)) throw new Error('Use 3-4 octal digits, e.g. 644 or 755');
    await window.api.chmod(tab.sid, full, parseInt(val, 8));
    await browse(tab, tab.cwd);
  });
}

function deleteEntry(tab, e, full) {
  return guarded(tab, 'Delete', async () => {
    const what = e.isDir ? `folder "${e.name}" and everything in it` : `"${e.name}"`;
    if (!confirm(`Permanently delete ${what} from the server? This cannot be undone.`)) return;
    await window.api.remove(tab.sid, full);
    if (tab.editing && (tab.editing === full || tab.editing.startsWith(full + '/'))) closeEditor(tab, true);
    await browse(tab, tab.cwd);
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
    if (r) await browse(tab, tab.cwd);
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
    await browse(tab, tab.cwd);
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
  let attempt = input;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const res = await window.api.connect(attempt);
      tab.sid = res.id;
      bySid.set(res.id, tab);
      tab.msgEl.textContent = 'Connected';
      browse(tab, res.home);
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

async function loadProfiles() {
  profiles = (await window.api.profiles.list()).sort((a, b) => a.name.localeCompare(b.name));
  const ul = $('sessionList');
  ul.textContent = '';
  for (const p of profiles) {
    const li = el('li');
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
    ul.appendChild(li);
  }
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

function openSessionDialog(p) {
  $('form').reset();
  const jump = $('f-jump');
  jump.textContent = '';
  jump.append(new Option('None', ''));
  for (const o of profiles) if (!p || o.id !== p.id) jump.append(new Option(`${o.name} (${o.username}@${o.host})`, o.id));
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
  $('f-pass').placeholder = p?.hasSecret ? 'Saved; leave blank to keep it' : 'Password (or key passphrase)';
  jump.value = p?.jumpHostId ?? '';
  $('dlg').showModal();
  $('f-host').focus();
}

$('new').onclick = () => openSessionDialog(null);
$('f-cancel').onclick = () => $('dlg').close();
$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  const editing = $('f-id').value || undefined;
  const host = $('f-host').value.trim();
  const username = $('f-user').value.trim();
  const port = Number($('f-port').value) || 22;
  const password = $('f-pass').value;
  const privateKeyPath = $('f-key').value.trim() || undefined;
  const jumpHostId = $('f-jump').value || undefined;
  const name = $('f-name').value.trim() || `${username || 'me'}@${host}`;
  $('dlg').close();
  try {
    if (editing || $('f-save').checked) {
      const id = await window.api.profiles.save({ id: editing, name, host, port, username, privateKeyPath, jumpHostId }, password || undefined);
      await loadProfiles();
      if (!editing) connect({ profileId: id }, name);
    } else {
      connect({ host, port, username, password, privateKeyPath, jumpHostId }, name);
    }
  } catch (err) {
    note('Could not save: ' + (err.message || err));
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
