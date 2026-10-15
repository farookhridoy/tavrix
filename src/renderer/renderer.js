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
  tab.cwdEl = el('div', 'cwd', '/');
  tab.filesEl = el('ul', 'files');
  aside.append(tab.cwdEl, tab.filesEl);
  const work = el('div', 'work');
  tab.termEl = el('div', 'term');
  tab.editorEl = el('div', 'editor');
  tab.editorEl.hidden = true;
  const bar = el('div', 'editbar');
  tab.editPathEl = el('span', 'editpath');
  const save = el('button', '', 'Save');
  const closeEdit = el('button', '', 'Close');
  bar.append(tab.editPathEl, save, closeEdit);
  tab.editArea = el('textarea', 'editarea');
  tab.editArea.spellcheck = false;
  tab.editorEl.append(bar, tab.editArea);
  tab.statusEl = el('div', 'status');
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
  tab.term.dispose();
  tab.header.remove();
  tab.pane.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  if (active === tab) active = null;
  if (tabs.length) activate(tabs[tabs.length - 1]);
}

/* ---------- files and editor ---------- */

async function browse(tab, path) {
  try {
    const items = await window.api.list(tab.sid, path);
    tab.cwd = path;
    tab.cwdEl.textContent = path;
    tab.filesEl.textContent = '';
    if (path !== '/') items.unshift({ name: '..', isDir: true });
    for (const e of items) {
      const li = el('li', '', (e.isDir ? '📁 ' : '📄 ') + e.name);
      li.onclick = () => {
        const next = e.name === '..'
          ? path.replace(/\/[^/]+\/?$/, '') || '/'
          : (path === '/' ? '' : path) + '/' + e.name;
        e.isDir ? browse(tab, next) : openFile(tab, next);
      };
      tab.filesEl.appendChild(li);
    }
  } catch (err) {
    tab.statusEl.textContent = String(err.message || err);
  }
}

async function openFile(tab, path) {
  if (tab.editing && tab.editDirty && !confirm('Discard unsaved changes in ' + tab.editing + '?')) return;
  try {
    tab.editArea.value = await window.api.readFile(tab.sid, path);
    tab.editing = path;
    tab.editDirty = false;
    tab.editArea.oninput = () => { tab.editDirty = true; };
    tab.editPathEl.textContent = path;
    tab.editorEl.hidden = false;
    refit(tab);
  } catch (err) {
    tab.statusEl.textContent = String(err.message || err);
  }
}

async function saveFile(tab) {
  if (!tab.editing) return;
  try {
    await window.api.writeFile(tab.sid, tab.editing, tab.editArea.value);
    tab.editDirty = false;
    tab.statusEl.textContent = 'Saved ' + tab.editing;
  } catch (err) {
    tab.statusEl.textContent = 'Save failed: ' + (err.message || err);
  }
}

function closeEditor(tab) {
  if (tab.editDirty && !confirm('Discard unsaved changes?')) return;
  tab.editorEl.hidden = true;
  tab.editing = null;
  tab.editDirty = false;
  refit(tab);
}

/* ---------- connecting ---------- */

async function connect(input, title) {
  const tab = createTab(title);
  tab.statusEl.textContent = 'Connecting...';
  try {
    const res = await window.api.connect(input, tab.term.cols, tab.term.rows);
    tab.sid = res.id;
    bySid.set(res.id, tab);
    tab.statusEl.textContent = 'Connected';
    refit(tab);
    browse(tab, res.home);
  } catch (err) {
    tab.statusEl.textContent = 'Failed: ' + (err.message || err);
    tab.term.write('\r\n\x1b[31mConnection failed:\x1b[0m ' + (err.message || err) + '\r\n');
  }
}

window.api.onData((id, d) => bySid.get(id)?.term.write(d));
window.api.onClosed((id) => {
  const tab = bySid.get(id);
  if (!tab) return;
  tab.statusEl.textContent = 'Disconnected';
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
  // Key-auth profiles from ssh_config have no stored secret; connect directly and let the key work.
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
