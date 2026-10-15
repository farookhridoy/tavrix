import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Session, ConnectRequest } from './ssh';

const sessions = new Map<string, Session>();

function get(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error('Session not found');
  return s;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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

function registerIpc(): void {
  ipcMain.handle('ssh:connect', async (e, req: ConnectRequest, cols: number, rows: number) => {
    const id = randomUUID();
    const session = new Session();
    await session.connect(req);
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
    const home = await session.realpath('.');
    return { id, home };
  });
  ipcMain.on('ssh:write', (_e, id: string, data: string) => get(id).write(data));
  ipcMain.on('ssh:resize', (_e, id: string, cols: number, rows: number) => get(id).resize(cols, rows));
  ipcMain.handle('sftp:list', (_e, id: string, path: string) => get(id).list(path));
  ipcMain.handle('sftp:read', (_e, id: string, path: string) => get(id).readFile(path));
  ipcMain.handle('sftp:write', (_e, id: string, path: string, content: string) => get(id).writeFile(path, content));
  ipcMain.handle('ssh:disconnect', (_e, id: string) => {
    sessions.get(id)?.close();
    sessions.delete(id);
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
