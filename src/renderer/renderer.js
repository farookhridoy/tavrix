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
      { label: 'New folder', run: () => newFolder(tab) },
      { label: 'Upload here…', run: () => upload(tab) },
      { label: 'Refresh', run: () => browse(tab, tab.cwd) },
    ]);
  });
  const work = el('div', 'work');
  tab.termEl = el('div', 'term');
  tab.editorEl = el('div', 'editor');
  tab.editorEl.hidden = true;
  const bar = el('div', 'editbar');
  tab.editPathEl = el('span', 'editpath');
  const save = el('button', '', 'Save');
  const closeEdit = el('button', '', 'Close');
  bar.append(tab.editPathEl, save, closeEdit);
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
  tab.statusEl.append(tab.msgEl, tab.progEl, tab.cancelBtn);
  work.append(tab.termEl, tab.editorEl, tab.statusEl);
  tab.pane.append(aside, work);

  tab.term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: true });
  tab.fit = new FitAddon.FitAddon();
  tab.term.loadAddon(tab.fit);
  tab.term.onData((d) => tab.sid && window.api.write(tab.sid, d));

  save.onclick = () => saveFile(tab);
  closeEdit.onclick = () => closeEditor(tab);

  $('tabbar').appendChild(tab.header);
  $('panes').appendChild(tab.pane);
  tabs.push(tab);
  tab.opened = false;
  activate(tab);
  return tab;
}

function activate(tab) {
  active = tab;
  for (const t of tabs) {
    t.header.classList.toggle('active', t === tab);
    t.pane.classList.toggle('active', t === tab);
  }
  if (!tab.opened) { tab.term.open(tab.termEl); tab.opened = true; }
  requestAnimationFrame(() => refit(tab));
}

function refit(tab) {
  try {
    tab.fit.fit();
    if (tab.sid) window.api.resize(tab.sid, tab.term.cols, tab.term.rows);
  } catch { /* pane hidden */ }
}

function closeTab(tab) {
  if (tab.editing && tab.editDirty && !confirm('Discard unsaved changes in ' + tab.editing + '?')) return;
  if (tab.sid) { window.api.disconnect(tab.sid); bySid.delete(tab.sid); }
  tab.editor?.dispose();
  tab.model?.dispose();
  tab.term.dispose();
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

async function openFile(tab, path) {
  if (tab.editing === path) return;
  if (tab.editing && tab.editDirty && !confirm('Discard unsaved changes in ' + tab.editing + '?')) return;
  try {
    const text = await window.api.readFile(tab.sid, path);
    const monaco = await ensureEditor(tab);
    const old = tab.model;
    tab.model = monaco.editor.createModel(text, undefined, monaco.Uri.from({ scheme: 'file', path }));
    tab.editor.setModel(tab.model);
    old?.dispose();
    tab.editing = path;
    tab.editDirty = false;
    tab.model.onDidChangeContent(() => { tab.editDirty = true; tab.editPathEl.textContent = path + ' ●'; });
    tab.editPathEl.textContent = path;
    tab.editorEl.hidden = false;
    refit(tab);
    tab.editor.focus();
  } catch (err) {
    tab.msgEl.textContent = String(err.message || err);
  }
}

async function saveFile(tab) {
  if (!tab.editing) return;
  try {
    await window.api.writeFile(tab.sid, tab.editing, tab.model.getValue());
    tab.editDirty = false;
    tab.editPathEl.textContent = tab.editing;
    tab.msgEl.textContent = 'Saved ' + tab.editing;
  } catch (err) {
    tab.msgEl.textContent = 'Save failed: ' + (err.message || err);
  }
}

function closeEditor(tab, force = false) {
  if (!force && tab.editDirty && !confirm('Discard unsaved changes?')) return;
  tab.editorEl.hidden = true;
  tab.editing = null;
  tab.editDirty = false;
  tab.editor?.setModel(null);
  tab.model?.dispose();
  tab.model = null;
  refit(tab);
}

/* ---------- connecting ---------- */

async function connect(input, title) {
  const tab = createTab(title);
  tab.msgEl.textContent = 'Connecting...';
  let attempt = input;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const res = await window.api.connect(attempt, tab.term.cols, tab.term.rows);
      tab.sid = res.id;
      bySid.set(res.id, tab);
      tab.msgEl.textContent = 'Connected';
      refit(tab);
      browse(tab, res.home);
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

function connectFailed(tab, message) {
  tab.msgEl.textContent = 'Failed: ' + message;
  tab.term.write('\r\n\x1b[31mConnection failed:\x1b[0m ' + message + '\r\n');
}

window.api.onData((id, d) => bySid.get(id)?.term.write(d));
window.api.onClosed((id) => {
  const tab = bySid.get(id);
  if (!tab) return;
  tab.msgEl.textContent = 'Disconnected';
  tab.sid = null;
  bySid.delete(id);
});
window.addEventListener('resize', () => active && refit(active));

/* ---------- saved sessions ---------- */

async function loadProfiles() {
  const list = await window.api.profiles.list();
  const ul = $('sessionList');
  ul.textContent = '';
  for (const p of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const li = el('li');
    const info = el('div');
    info.append(el('div', '', p.name));
    info.append(el('small', '', `${p.username}@${p.host}${p.port !== 22 ? ':' + p.port : ''}`));
    const x = el('button', 'x', '×');
    x.title = 'Delete saved session';
    x.onclick = async (e) => {
      e.stopPropagation();
      if (confirm('Delete saved session "' + p.name + '"?')) {
        await window.api.profiles.remove(p.id);
        loadProfiles();
      }
    };
    li.append(info, x);
    li.onclick = () => connectProfile(p);
    ul.appendChild(li);
  }
}

function connectProfile(p) {
  connect({ profileId: p.id }, p.name);
}

$('import').onclick = async () => {
  const r = await window.api.profiles.importSshConfig();
  note(`Imported ${r.added}, skipped ${r.skipped} existing.`);
  loadProfiles();
};

/* ---------- new connection dialog ---------- */

$('new').onclick = () => { $('form').reset(); $('f-port').value = 22; $('dlg').showModal(); $('f-host').focus(); };
$('f-cancel').onclick = () => $('dlg').close();
$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  const host = $('f-host').value.trim();
  const username = $('f-user').value.trim();
  const port = Number($('f-port').value) || 22;
  const password = $('f-pass').value;
  const privateKeyPath = $('f-key').value.trim() || undefined;
  const name = $('f-name').value.trim() || `${username}@${host}`;
  $('dlg').close();
  try {
    if ($('f-save').checked) {
      const id = await window.api.profiles.save({ name, host, port, username, privateKeyPath }, password || undefined);
      loadProfiles();
      connect({ profileId: id }, name);
    } else {
      connect({ host, port, username, password, privateKeyPath }, name);
    }
  } catch (err) {
    note('Could not save: ' + (err.message || err));
  }
};

loadProfiles();
