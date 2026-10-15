import { app, BrowserWindow, ipcMain, dialog, shell, Menu, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Session, ConnectRequest, Progress, KeyPassphraseError, JumpHostError, Hop, FileStat } from './ssh';
import type { ForwardSpec } from './forwards';
import { parseSshConfig } from './sshconfig';
import {
  Profile,
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  readSecret,
  knownFingerprint,
  trustHost,
  listSnippets,
  saveSnippet,
  deleteSnippet,
  Snippet,
  getSettings,
  saveSettings,
} from './store';
import { sanitizeConnection, sanitizeTerminal, sanitizeFolder, startupInput, DEFAULT_TERMINAL, DEFAULT_CONNECTION } from './prefs';
import { checkForUpdate, openTarget, FEED_URL, UpdateInfo } from './updates';

const sessions = new Map<string, Session>();
/** Startup input per connection, typed into the first shell opened on it and then forgotten. */
const pendingStartup = new Map<string, string>();

interface ConnectInput extends Partial<ConnectRequest> {
  profileId?: string;
  /** Saved session to pass through first, for an unsaved connection. */
  jumpHostId?: string;
  /** Password or key passphrase typed at connect time; never persisted. */
  secret?: string;
  /** For an unsaved connection: typed into the first shell. */
  startupDir?: string;
  startupCommand?: string;
}

/** Marker the renderer matches to ask the user for a password/passphrase and retry. */
const NEEDS_SECRET = 'NEEDS_SECRET';

function get(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error('Session not found');
  return s;
}

function toBase64(hex: string): string {
  return 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
}

function resolveRequest(input: ConnectInput): ConnectRequest {
  const base = input.profileId ? profileBase(input.profileId) : input;
  const { host, port, username, privateKeyPath } = base;
  if (!host) throw new Error('Host is required');
  const defaults = getSettings().connection;
  const own = sanitizeConnection(base);
  const secret = input.secret ?? input.password ?? (input.profileId ? readProfileSecret(input.profileId) : undefined);
  return {
    host,
    port: port || 22,
    // Like OpenSSH, default to the local account name when none is configured.
    username: username || userInfo().username,
    privateKeyPath: privateKeyPath || undefined,
    password: privateKeyPath ? undefined : secret,
    passphrase: privateKeyPath ? secret : undefined,
    keepAliveSec: own.keepAliveSec ?? defaults.keepAliveSec,
    compression: own.compression ?? defaults.compression,
    connectTimeoutSec: own.connectTimeoutSec ?? defaults.connectTimeoutSec,
  };
}

/** What to type into the first shell of this connection (startup folder and command), or ''. */
function startupFor(input: ConnectInput): string {
  const src = input.profileId ? profileBase(input.profileId) : input;
  return startupInput(src.startupDir, src.startupCommand);
}

/** The only fields a saved session may have, each validated; anything else the UI sends is dropped. */
function cleanProfile(p: Partial<Profile> & Record<string, unknown>, id: string): Profile {
  const text = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const conn = sanitizeConnection(p);
  const terminal = sanitizeTerminal(p.terminal);
  return {
    id,
    name: text(p.name, 100) ?? 'Untitled',
    host: text(p.host, 255) ?? '',
    port: Math.min(65535, Math.max(1, Math.round(Number(p.port)) || 22)),
    username: text(p.username, 100) ?? '',
    privateKeyPath: text(p.privateKeyPath, 1000),
    jumpHostId: text(p.jumpHostId, 100),
    folder: sanitizeFolder(p.folder),
    startupDir: text(p.startupDir, 1000),
    startupCommand: text(p.startupCommand, 2000),
    ...conn,
    terminal: Object.keys(terminal).length ? terminal : undefined,
  };
}

function profileBase(id: string): Profile {
  const p = getProfile(id);
  if (!p) throw new Error('Saved session not found');
  return p;
}

function readProfileSecret(id: string): string | undefined {
  return readSecret(profileBase(id));
}

/** Turn "we need a secret from the user" failures into a marker the renderer can act on. */
function classifyConnectError(err: unknown, req: ConnectRequest): Error {
  if (err instanceof JumpHostError) return err; // a jump host problem is never a prompt for the destination's secret
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof KeyPassphraseError) {
    return new Error(`${NEEDS_SECRET}:passphrase${err.reason === 'wrong' ? ':Wrong passphrase' : ''}`);
  }
  if (!req.privateKeyPath && /all configured authentication methods failed/i.test(msg)) {
    return new Error(`${NEEDS_SECRET}:password${req.password ? ':Authentication failed' : ''}`);
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Hops to traverse before the destination, outermost first. Jump hosts use their saved credentials. */
function jumpHops(win: BrowserWindow | null, input: ConnectInput): Hop[] {
  const hops: Hop[] = [];
  const seen = new Set<string>(input.profileId ? [input.profileId] : []);
  let id = input.profileId ? getProfile(input.profileId)?.jumpHostId : input.jumpHostId;
  while (id) {
    if (seen.has(id) || seen.size > 5) throw new Error('The jump host chain is circular or longer than 5 hops');
    seen.add(id);
    const req = resolveRequest({ profileId: id });
    hops.unshift({ req, verify: hostVerifier(win, req.host, req.port) });
    id = profileBase(id).jumpHostId;
  }
  return hops;
}

function hostVerifier(win: BrowserWindow | null, host: string, port: number) {
  return async (hex: string): Promise<boolean> => {
    const fp = toBase64(hex);
    const known = knownFingerprint(host, port);
    if (known === fp) return true;
    const opts = win ? [win] : [];
    if (known) {
      await dialog.showMessageBox(...(opts as [BrowserWindow]), {
        type: 'error',
        message: `Host key for ${host}:${port} has CHANGED`,
        detail: `Saved: ${known}\nPresented: ${fp}\n\nThe connection was blocked. This could be a man-in-the-middle attack. If the server was reinstalled, remove its entry from known_hosts.json in the app data folder.`,
        buttons: ['OK'],
      });
      return false;
    }
    const r = await dialog.showMessageBox(...(opts as [BrowserWindow]), {
      type: 'question',
      message: `Trust new host ${host}:${port}?`,
      detail: `Fingerprint:\n${fp}`,
      buttons: ['Trust and connect', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return false;
    trustHost(host, port, fp);
    return true;
  };
}

/* ---------- updates ---------- */

let pendingUpdate: UpdateInfo | null = null;
const HOUR = 3600_000;

/** Test hooks apply only to unpackaged runs, so a shipped app can only ever ask this project's GitHub feed. */
const feedUrl = (): string => (!app.isPackaged && process.env.TAVRIX_UPDATE_URL) || FEED_URL;

function announceUpdate(): void {
  if (!pendingUpdate) return;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:available', pendingUpdate);
}

async function runUpdateCheck(manual: boolean): Promise<void> {
  if (!manual && !getSettings().updateCheck) return;
  const r = await checkForUpdate(app.getVersion(), fetch as never, feedUrl());
  if (r.kind === 'available') {
    if (!manual && getSettings().skippedVersion === r.info.latest) return;
    pendingUpdate = r.info;
    announceUpdate();
    if (manual) BrowserWindow.getAllWindows()[0]?.focus();
    return;
  }
  if (!manual) return; // background checks stay silent unless there is something to say
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    type: r.kind === 'error' ? ('warning' as const) : ('info' as const),
    message: r.kind === 'current' ? `Tavrix ${r.current} is up to date` : r.kind === 'none' ? 'No releases have been published yet' : 'Could not check for updates',
    detail: r.kind === 'error' ? r.message : r.kind === 'current' ? `The latest release is ${r.latest}.` : undefined,
    buttons: ['OK'],
  };
  if (win) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

function scheduleUpdateChecks(): void {
  const first = Number(!app.isPackaged && process.env.TAVRIX_UPDATE_DELAY_MS) || 10_000;
  setTimeout(() => void runUpdateCheck(false), first);
  setInterval(() => void runUpdateCheck(false), 12 * HOUR).unref();
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => BrowserWindow.getAllWindows()[0]?.webContents.send('ui:open-settings'),
        },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void runUpdateCheck(true) },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: getSettings().updateCheck,
          click: (item) => saveSettings({ updateCheck: item.checked }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 840,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(join(__dirname, '../../src/renderer/index.html'));
  win.webContents.on('did-finish-load', announceUpdate); // a window opened after the check still gets the banner
  return win;
}

function publicProfile(p: Profile) {
  const { secret, ...rest } = p;
  return { ...rest, hasSecret: Boolean(secret) };
}

function registerIpc(): void {
  ipcMain.handle('ssh:connect', async (e, input: ConnectInput) => {
    const req = resolveRequest(input);
    const id = randomUUID();
    const session = new Session();
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      await session.connect(req, hostVerifier(win, req.host, req.port), jumpHops(win, input));
    } catch (err) {
      throw classifyConnectError(err, req);
    }
    sessions.set(id, session);
    pendingStartup.set(id, startupFor(input));
    session.onDisconnect(() => {
      pendingStartup.delete(id);
      if (sessions.delete(id)) e.sender.send('ssh:closed', id);
    });
    return { id, home: await session.realpath('.') };
  });
  ipcMain.handle('ssh:open-shell', (e, id: string, cols: number, rows: number) => {
    const session = get(id);
    const opened = session.openShell(
      cols,
      rows,
      (shellId, d) => e.sender.send('ssh:data', id, shellId, d),
      (shellId) => {
        e.sender.send('ssh:shell-closed', id, shellId);
        // Typing `exit` in the last shell ends the session, as before split panes existed.
        if (session.shellCount() === 0) session.close();
      },
    );
    return opened.then((shellId) => {
      // Only the first shell gets the startup folder/command. It is typed like a user would, so it is visible in the terminal.
      const startup = pendingStartup.get(id);
      pendingStartup.delete(id);
      if (startup) session.write(shellId, startup);
      return shellId;
    });
  });
  ipcMain.on('ssh:write', (_e, id: string, shellId: string, data: string) => sessions.get(id)?.write(shellId, data));
  ipcMain.on('ssh:resize', (_e, id: string, shellId: string, cols: number, rows: number) => sessions.get(id)?.resize(shellId, cols, rows));
  ipcMain.on('ssh:close-shell', (_e, id: string, shellId: string) => sessions.get(id)?.closeShell(shellId));
  ipcMain.handle('sftp:list', (_e, id: string, path: string) => get(id).list(path));
  // The stat is taken before the bytes are read, so a later change is never mistaken for "unchanged".
  ipcMain.handle('sftp:open', (_e, id: string, path: string) => get(id).openText(path));
  ipcMain.handle('sftp:stat', (_e, id: string, path: string) => get(id).stat(path));
  ipcMain.handle('sftp:create', (_e, id: string, path: string) => get(id).createFile(path));
  ipcMain.handle(
    'sftp:save',
    (_e, id: string, path: string, content: string, expected: FileStat | undefined, force: boolean) =>
      get(id).saveFile(path, content, expected, Boolean(force)),
  );

  ipcMain.handle('sftp:mkdir', (_e, id: string, path: string) => get(id).mkdir(path));
  ipcMain.handle('sftp:rename', (_e, id: string, from: string, to: string) => get(id).rename(from, to));
  ipcMain.handle('sftp:chmod', (_e, id: string, path: string, mode: number) => get(id).chmod(path, mode));
  ipcMain.handle('sftp:remove', (_e, id: string, path: string) => get(id).remove(path));

  const progressSender = (e: IpcMainInvokeEvent, id: string) => {
    let last = 0;
    return (p: Progress) => {
      const now = Date.now();
      if (now - last < 100 && p.done < p.total) return;
      last = now;
      e.sender.send('xfer:progress', id, p);
    };
  };
  const overwriteAsker = (win: BrowserWindow | null) => async (name: string) => {
    const opts = {
      type: 'question' as const,
      message: `"${name}" already exists. Replace it?`,
      buttons: ['Replace', 'Skip'],
      defaultId: 1,
      cancelId: 1,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  };

  // locals is omitted when the user picks files through the dialog; drag and drop passes paths.
  ipcMain.handle('xfer:upload', async (e, id: string, remoteDir: string, locals?: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    let paths = locals;
    if (!paths) {
      const opts = { properties: ['openFile', 'openDirectory', 'multiSelections'] as ('openFile' | 'openDirectory' | 'multiSelections')[] };
      const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (pick.canceled) return null;
      paths = pick.filePaths;
    }
    return get(id).upload(paths, remoteDir, progressSender(e, id), overwriteAsker(win));
  });
  ipcMain.on('xfer:cancel', (_e, id: string) => sessions.get(id)?.cancelTransfer());
  ipcMain.handle('xfer:download', async (e, id: string, remotes: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      title: 'Choose where to save',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      defaultPath: app.getPath('downloads'),
    };
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (pick.canceled || !pick.filePaths[0]) return null;
    return get(id).download(remotes, pick.filePaths[0], progressSender(e, id), overwriteAsker(win));
  });

  ipcMain.handle('ssh:disconnect', (_e, id: string) => {
    sessions.get(id)?.close();
    sessions.delete(id);
  });

  // The renderer only says which button was pressed; the URL always comes from what the main process verified.
  ipcMain.handle('update:open', async (_e, kind: 'download' | 'notes') => {
    const url = openTarget(pendingUpdate, kind === 'notes' ? 'notes' : 'download');
    if (url) await shell.openExternal(url);
  });
  ipcMain.handle('update:skip', () => {
    if (pendingUpdate) saveSettings({ skippedVersion: pendingUpdate.latest });
    pendingUpdate = null;
  });

  ipcMain.handle('settings:get', () => ({ ...getSettings(), defaults: { terminal: DEFAULT_TERMINAL, connection: DEFAULT_CONNECTION } }));
  ipcMain.handle('settings:set', (_e, patch: { terminal?: unknown; connection?: unknown }) => {
    // The renderer may change appearance and connection defaults; update-check fields stay under the menu's control.
    const next = saveSettings({ terminal: patch?.terminal, connection: patch?.connection });
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', next);
    return next;
  });

  ipcMain.handle('fwd:list', (_e, id: string) => get(id).forwards.list());
  ipcMain.handle('fwd:start', async (e, id: string, raw: ForwardSpec) => {
    const spec: ForwardSpec = {
      kind: raw.kind,
      bindHost: String(raw.bindHost || '127.0.0.1'),
      bindPort: Number(raw.bindPort),
      destHost: raw.destHost ? String(raw.destHost) : undefined,
      destPort: raw.destPort ? Number(raw.destPort) : undefined,
    };
    if (!['local', 'remote', 'dynamic'].includes(spec.kind)) throw new Error('Unknown tunnel type');
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(spec.bindHost);
    if (spec.kind !== 'remote' && !loopback) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = {
        type: 'warning' as const,
        message: `Listen on ${spec.bindHost}?`,
        detail: 'Anyone who can reach this Mac on that address will be able to use the tunnel.',
        buttons: ['Listen', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) throw new Error('Cancelled');
    }
    return get(id).forwards.start(spec);
  });
  ipcMain.handle('fwd:stop', (_e, id: string, fwdId: string) => get(id).forwards.stop(fwdId));

  ipcMain.handle('snippets:list', () => listSnippets());
  ipcMain.handle('snippets:save', (_e, sn: Partial<Snippet>) => {
    if (!sn.name || !sn.text) throw new Error('A snippet needs a name and text');
    const snippet: Snippet = { id: sn.id ?? randomUUID(), name: String(sn.name), text: String(sn.text), run: Boolean(sn.run) };
    saveSnippet(snippet);
    return snippet.id;
  });
  ipcMain.handle('snippets:delete', (_e, id: string) => deleteSnippet(id));

  ipcMain.handle('profiles:list', () => listProfiles().map(publicProfile));
  ipcMain.handle(
    'profiles:save',
    (_e, p: Partial<Profile> & Record<string, unknown>, secret?: string) => {
      const profile = cleanProfile(p, typeof p.id === 'string' && p.id ? p.id : randomUUID());
      if (!profile.host) throw new Error('A host is required');
      if (profile.jumpHostId && (profile.jumpHostId === profile.id || !getProfile(profile.jumpHostId))) {
        throw new Error('Choose a different saved session as the jump host');
      }
      saveProfile(profile, secret || undefined);
      return profile.id;
    },
  );

  ipcMain.handle('profiles:delete', (_e, id: string) => deleteProfile(id));
  ipcMain.handle('profiles:import-ssh-config', () => {
    let text: string;
    try {
      text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8');
    } catch {
      return { added: 0, skipped: 0 };
    }
    const existing = new Set(listProfiles().map((p) => `${p.username}@${p.host}:${p.port}`));
    let added = 0;
    let skipped = 0;
    const hosts = parseSshConfig(text, homedir(), userInfo().username);
    for (const h of hosts) {
      const key = `${h.username}@${h.host}:${h.port}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      saveProfile({
        id: randomUUID(),
        name: h.alias,
        host: h.host,
        port: h.port,
        username: h.username,
        privateKeyPath: h.privateKeyPath,
      });
      existing.add(key);
      added++;
    }
    // Second pass, once every host has a profile: link ProxyJump aliases (single hop only).
    let jumpsLinked = 0;
    let jumpsUnresolved = 0;
    for (const h of hosts) {
      if (!h.proxyJump) continue;
      const me = listProfiles().find((p) => p.name === h.alias);
      const target = h.proxyJump.includes(',') ? undefined : listProfiles().find((p) => p.name === h.proxyJump);
      if (!me || !target || target.id === me.id || me.jumpHostId) {
        if (!me?.jumpHostId) jumpsUnresolved++;
        continue;
      }
      saveProfile({ ...me, jumpHostId: target.id });
      jumpsLinked++;
    }
    return { added, skipped, jumpsLinked, jumpsUnresolved };
  });
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  scheduleUpdateChecks();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.close();
  if (process.platform !== 'darwin') app.quit();
});
