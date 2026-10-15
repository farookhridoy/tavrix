import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('api', {
  connect: (input: unknown) => ipcRenderer.invoke('ssh:connect', input),
  openShell: (id: string, cols: number, rows: number) => ipcRenderer.invoke('ssh:open-shell', id, cols, rows),
  write: (id: string, shellId: string, data: string) => ipcRenderer.send('ssh:write', id, shellId, data),
  resize: (id: string, shellId: string, cols: number, rows: number) => ipcRenderer.send('ssh:resize', id, shellId, cols, rows),
  closeShell: (id: string, shellId: string) => ipcRenderer.send('ssh:close-shell', id, shellId),
  forwards: {
    list: (id: string) => ipcRenderer.invoke('fwd:list', id),
    start: (id: string, spec: unknown) => ipcRenderer.invoke('fwd:start', id, spec),
    stop: (id: string, fwdId: string) => ipcRenderer.invoke('fwd:stop', id, fwdId),
  },
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (s: unknown) => ipcRenderer.invoke('snippets:save', s),
    remove: (id: string) => ipcRenderer.invoke('snippets:delete', id),
  },
  list: (id: string, path: string) => ipcRenderer.invoke('sftp:list', id, path),
  readFile: (id: string, path: string) => ipcRenderer.invoke('sftp:read', id, path),
  writeFile: (id: string, path: string, content: string) => ipcRenderer.invoke('sftp:write', id, path, content),
  mkdir: (id: string, path: string) => ipcRenderer.invoke('sftp:mkdir', id, path),
  rename: (id: string, from: string, to: string) => ipcRenderer.invoke('sftp:rename', id, from, to),
  chmod: (id: string, path: string, mode: number) => ipcRenderer.invoke('sftp:chmod', id, path, mode),
  remove: (id: string, path: string) => ipcRenderer.invoke('sftp:remove', id, path),
  upload: (id: string, remoteDir: string, locals?: string[]) => ipcRenderer.invoke('xfer:upload', id, remoteDir, locals),
  download: (id: string, remotes: string[]) => ipcRenderer.invoke('xfer:download', id, remotes),
  cancelTransfer: (id: string) => ipcRenderer.send('xfer:cancel', id),
  pathFor: (file: File) => webUtils.getPathForFile(file),
  onProgress: (cb: (id: string, p: { name: string; done: number; total: number }) => void) =>
    ipcRenderer.on('xfer:progress', (_e, id, p) => cb(id, p)),
  disconnect: (id: string) => ipcRenderer.invoke('ssh:disconnect', id),
  onData: (cb: (id: string, shellId: string, d: string) => void) => ipcRenderer.on('ssh:data', (_e, id, shellId, d) => cb(id, shellId, d)),
  onShellClosed: (cb: (id: string, shellId: string) => void) => ipcRenderer.on('ssh:shell-closed', (_e, id, shellId) => cb(id, shellId)),
  onClosed: (cb: (id: string) => void) => ipcRenderer.on('ssh:closed', (_e, id) => cb(id)),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (p: unknown, secret?: string) => ipcRenderer.invoke('profiles:save', p, secret),
    remove: (id: string) => ipcRenderer.invoke('profiles:delete', id),
    importSshConfig: () => ipcRenderer.invoke('profiles:import-ssh-config'),
  },
});
