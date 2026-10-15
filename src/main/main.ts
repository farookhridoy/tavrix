import { app, BrowserWindow, ipcMain, dialog, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Session, ConnectRequest, Progress, KeyPassphraseError } from './ssh';
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
} from './store';

const sessions = new Map<string, Session>();

interface ConnectInput extends Partial<ConnectRequest> {
  profileId?: string;
  /** Password or key passphrase typed at connect time; never persisted. */
  secret?: string;
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
  const secret = input.secret ?? input.password ?? (input.profileId ? readProfileSecret(input.profileId) : undefined);
  return {
    host,
    port: port || 22,
    // Like OpenSSH, default to the local account name when none is configured.
    username: username || userInfo().username,
    privateKeyPath: privateKeyPath || undefined,
    password: privateKeyPath ? undefined : secret,
    passphrase: privateKeyPath ? secret : undefined,
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
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof KeyPassphraseError) {
    return new Error(`${NEEDS_SECRET}:passphrase${err.reason === 'wrong' ? ':Wrong passphrase' : ''}`);
  }
  if (!req.privateKeyPath && /all configured authentication methods failed/i.test(msg)) {
    return new Error(`${NEEDS_SECRET}:password${req.password ? ':Authentication failed' : ''}`);
  }
  return err instanceof Error ? err : new Error(msg);
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
  return win;
}

function publicProfile(p: Profile) {
  const { secret, ...rest } = p;
  return { ...rest, hasSecret: Boolean(secret) };
}

function registerIpc(): void {
  ipcMain.handle('ssh:connect', async (e, input: ConnectInput, cols: number, rows: number) => {
    const req = resolveRequest(input);
    const id = randomUUID();
    const session = new Session();
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      await session.connect(req, hostVerifier(win, req.host, req.port));
    } catch (err) {
      session.close();
      throw classifyConnectError(err, req);
    }
    await session.openShell(
      cols,
      rows,
      (d) => e.sender.send('ssh:data', id, d),
      () => {
        sessions.delete(id);
        e.sender.send('ssh:closed', id);
      },
    );
    sessions.set(id, session);
    return { id, home: await session.realpath('.') };
  });
  ipcMain.on('ssh:write', (_e, id: string, data: string) => sessions.get(id)?.write(data));
  ipcMain.on('ssh:resize', (_e, id: string, cols: number, rows: number) => sessions.get(id)?.resize(cols, rows));
  ipcMain.handle('sftp:list', (_e, id: string, path: string) => get(id).list(path));
  ipcMain.handle('sftp:read', (_e, id: string, path: string) => get(id).readFile(path));
  ipcMain.handle('sftp:write', (_e, id: string, path: string, content: string) => get(id).writeFile(path, content));

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

  ipcMain.handle('profiles:list', () => listProfiles().map(publicProfile));
  ipcMain.handle(
    'profiles:save',
    (_e, p: Omit<Profile, 'id' | 'secret'> & { id?: string }, secret?: string) => {
      const profile: Profile = { ...p, id: p.id ?? randomUUID() };
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
    for (const h of parseSshConfig(text, homedir(), userInfo().username)) {
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
    return { added, skipped };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.close();
  if (process.platform !== 'darwin') app.quit();
});
