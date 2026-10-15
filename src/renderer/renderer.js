const $ = (id) => document.getElementById(id);
const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: true });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('term'));
fit.fit();

let sid = null;
let cwd = '/';
let editing = null;

const fmt = (e) => (e.isDir ? '📁 ' : '📄 ') + e.name;

async function browse(path) {
  try {
    const items = await window.api.list(sid, path);
    cwd = path;
    $('cwd').textContent = path;
    const ul = $('files');
    ul.textContent = '';
    if (path !== '/') items.unshift({ name: '..', isDir: true });
    for (const e of items) {
      const li = document.createElement('li');
      li.textContent = fmt(e);
      li.onclick = () => {
        const next = e.name === '..' ? path.replace(/\/[^/]+\/?$/, '') || '/' : (path === '/' ? '' : path) + '/' + e.name;
        e.isDir ? browse(next) : openFile(next);
      };
      ul.appendChild(li);
    }
  } catch (err) {
    $('status').textContent = String(err.message || err);
  }
}

async function openFile(path) {
  try {
    $('editarea').value = await window.api.readFile(sid, path);
    editing = path;
    $('editpath').textContent = path;
    $('editor').hidden = false;
    fit.fit();
  } catch (err) {
    $('status').textContent = String(err.message || err);
  }
}

$('save').onclick = async () => {
  if (!editing) return;
  try {
    await window.api.writeFile(sid, editing, $('editarea').value);
    $('status').textContent = 'Saved ' + editing;
  } catch (err) {
    $('status').textContent = 'Save failed: ' + (err.message || err);
  }
};
$('closeedit').onclick = () => { $('editor').hidden = true; editing = null; fit.fit(); };

$('connect').onsubmit = async (ev) => {
  ev.preventDefault();
  $('status').textContent = 'Connecting...';
  try {
    const res = await window.api.connect(
      {
        host: $('host').value,
        port: Number($('port').value) || 22,
        username: $('user').value,
        password: $('pass').value || undefined,
        privateKeyPath: $('key').value || undefined,
      },
      term.cols,
      term.rows,
    );
    sid = res.id;
    $('status').textContent = 'Connected';
    term.clear();
    browse(res.home);
  } catch (err) {
    $('status').textContent = 'Failed: ' + (err.message || err);
  }
};

term.onData((d) => sid && window.api.write(sid, d));
window.api.onData((id, d) => id === sid && term.write(d));
window.api.onClosed((id) => { if (id === sid) { $('status').textContent = 'Disconnected'; sid = null; } });
window.addEventListener('resize', () => { fit.fit(); sid && window.api.resize(sid, term.cols, term.rows); });
