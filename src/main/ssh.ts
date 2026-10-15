import { Client, ClientChannel, SFTPWrapper, FileEntryWithStats } from 'ssh2';
import { readFileSync } from 'node:fs';

export interface ConnectRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export class Session {
  private client = new Client();
  private shell?: ClientChannel;
  private sftpHandle?: SFTPWrapper;

  connect(req: ConnectRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.once('ready', () => resolve());
      this.client.once('error', reject);
      this.client.connect({
        host: req.host,
        port: req.port,
        username: req.username,
        password: req.password,
        privateKey: req.privateKeyPath ? readFileSync(req.privateKeyPath) : undefined,
        passphrase: req.passphrase,
        readyTimeout: 20000,
      });
    });
  }

  openShell(cols: number, rows: number, onData: (d: string) => void, onClose: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err);
        this.shell = stream;
        stream.on('data', (d: Buffer) => onData(d.toString('utf8')));
        stream.on('close', onClose);
        resolve();
      });
    });
  }

  write(data: string): void {
    this.shell?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.shell?.setWindow(rows, cols, 0, 0);
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpHandle) return Promise.resolve(this.sftpHandle);
    return new Promise((resolve, reject) => {
      this.client.sftp((err, s) => {
        if (err) return reject(err);
        this.sftpHandle = s;
        resolve(s);
      });
    });
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.readdir(path, (err, items: FileEntryWithStats[]) => {
        if (err) return reject(err);
        resolve(
          items
            .map((i) => ({
              name: i.filename,
              isDir: i.attrs.isDirectory(),
              size: i.attrs.size,
              mtime: i.attrs.mtime,
            }))
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)),
        );
      });
    });
  }

  async realpath(path: string): Promise<string> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => s.realpath(path, (e, p) => (e ? reject(e) : resolve(p))));
  }

  async readFile(path: string): Promise<string> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      s.createReadStream(path)
        .on('data', (c: Buffer) => chunks.push(c))
        .on('error', reject)
        .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.writeFile(path, Buffer.from(content, 'utf8'), (e) => (e ? reject(e) : resolve()));
    });
  }

  close(): void {
    this.client.end();
  }
}
