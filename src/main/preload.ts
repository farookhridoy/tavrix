import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  connect: (input: unknown, cols: number, rows: number) => ipcRenderer.invoke('ssh:connect', input, cols, rows),
  write: (id: string, data: string) => ipcRenderer.send('ssh:write', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('ssh:resize', id, cols, rows),
  list: (id: string, path: string) => ipcRenderer.invoke('sftp:list', id, path),
  readFile: (id: string, path: string) => ipcRenderer.invoke('sftp:read', id, path),
  writeFile: (id: string, path: string, content: string) => ipcRenderer.invoke('sftp:write', id, path, content),
  disconnect: (id: string) => ipcRenderer.invoke('ssh:disconnect', id),
  onData: (cb: (id: string, d: string) => void) => ipcRenderer.on('ssh:data', (_e, id, d) => cb(id, d)),
  onClosed: (cb: (id: string) => void) => ipcRenderer.on('ssh:closed', (_e, id) => cb(id)),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (p: unknown, secret?: string) => ipcRenderer.invoke('profiles:save', p, secret),
    remove: (id: string) => ipcRenderer.invoke('profiles:delete', id),
    importSshConfig: () => ipcRenderer.invoke('profiles:import-ssh-config'),
  },
});
