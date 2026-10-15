import { Client, ClientChannel, SFTPWrapper, FileEntryWithStats } from 'ssh2';
import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { posix, join as pathJoin, basename } from 'node:path';

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
  isLink: boolean;
  size: number;
  mtime: number;
  /** permission bits (mode & 0o7777) */
  mode: number;
}

export interface Progress {
  name: string;
  done: number;
  total: number;
}

export type OnProgress = (p: Progress) => void;
/** Asked once per top-level item that already exists at the destination. */
export type ConfirmOverwrite = (name: string) => Promise<boolean>;

export class Session {
  private client = new Client();
  private shell?: ClientChannel;
  private sftpHandle?: SFTPWrapper;

  connect(req: ConnectRequest, verifyHost: (sha256Hex: string) => Promise<boolean>): Promise<void> {
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
        hostHash: 'sha256',
        // ssh2 uses the callback when the function returns undefined.
        hostVerifier: ((hash: string, cb: (ok: boolean) => void): undefined => {
          verifyHost(hash).then(cb, () => cb(false));
        }) as unknown as (hash: string) => boolean,
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
              isLink: i.attrs.isSymbolicLink(),
              size: i.attrs.size,
              mtime: i.attrs.mtime,
              mode: i.attrs.mode & 0o7777,
            }))
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)),
        );
      });
    });
  }


  private async call<T>(fn: (s: SFTPWrapper, cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
    const s = await this.sftp();
    return new Promise<T>((resolve, reject) => fn(s, (err, v) => (err ? reject(err) : resolve(v as T))));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.call((s, cb) => s.lstat(path, (e) => cb(e)));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.call<void>((s, cb) => s.mkdir(path, (e) => cb(e)));
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`${posix.basename(to)} already exists`);
    await this.call<void>((s, cb) => s.rename(from, to, (e) => cb(e)));
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.call<void>((s, cb) => s.chmod(path, mode, (e) => cb(e)));
  }

  /** Delete a file or a directory tree. Symlinks are removed, never followed. */
  async remove(path: string): Promise<void> {
    const clean = posix.normalize(path);
    if (clean === '/' || clean === '.' || clean === '') throw new Error('Refusing to delete the root or an empty path');
    const st = await this.call<import('ssh2').Stats>((s, cb) => s.lstat(clean, cb));
    if (!st.isDirectory()) {
      await this.call<void>((s, cb) => s.unlink(clean, (e) => cb(e)));
      return;
    }
    for (const child of await this.list(clean)) await this.remove(posix.join(clean, child.name));
    await this.call<void>((s, cb) => s.rmdir(clean, (e) => cb(e)));
  }

  private async transferAll(
    plan: { src: string; dst: string; dir: boolean; size: number }[],
    kind: 'up' | 'down',
    onProgress: OnProgress,
  ): Promise<{ files: number; bytes: number }> {
    const total = plan.reduce((n, p) => n + p.size, 0);
    let done = 0;
    let files = 0;
    for (const p of plan) {
      const name = basename(kind === 'up' ? p.src : p.dst);
      if (p.dir) {
        if (kind === 'up') {
          if (!(await this.exists(p.dst))) await this.mkdir(p.dst);
        } else {
          await fsp.mkdir(p.dst, { recursive: true });
        }
        continue;
      }
      const base = done;
      await this.call<void>((s, cb) => {
        const opts = { step: (t: number) => onProgress({ name, done: base + t, total }) };
        if (kind === 'up') s.fastPut(p.src, p.dst, opts, (e) => cb(e));
        else s.fastGet(p.src, p.dst, opts, (e) => cb(e));
      });
      done += p.size;
      files++;
      onProgress({ name, done, total });
    }
    return { files, bytes: done };
  }

  /** Upload local files/folders into remoteDir. Symlinks are skipped. */
  async upload(
    locals: string[],
    remoteDir: string,
    onProgress: OnProgress,
    confirmOverwrite: ConfirmOverwrite,
  ): Promise<{ files: number; bytes: number }> {
    const plan: { src: string; dst: string; dir: boolean; size: number }[] = [];
    const walk = async (src: string, dst: string): Promise<void> => {
      const st = await fsp.lstat(src);
      if (st.isDirectory()) {
        plan.push({ src, dst, dir: true, size: 0 });
        for (const n of await fsp.readdir(src)) await walk(pathJoin(src, n), posix.join(dst, n));
      } else if (st.isFile()) {
        plan.push({ src, dst, dir: false, size: st.size });
      }
    };
    for (const local of locals) {
      const dst = posix.join(remoteDir, basename(local));
      if ((await this.exists(dst)) && !(await confirmOverwrite(basename(local)))) continue;
      await walk(local, dst);
    }
    return this.transferAll(plan, 'up', onProgress);
  }

  /** Download remote files/folders into localDir. Remote symlinks are skipped. */
  async download(
    remotes: string[],
    localDir: string,
    onProgress: OnProgress,
    confirmOverwrite: ConfirmOverwrite,
  ): Promise<{ files: number; bytes: number }> {
    const plan: { src: string; dst: string; dir: boolean; size: number }[] = [];
    const walk = async (src: string, dst: string): Promise<void> => {
      const st = await this.call<import('ssh2').Stats>((s, cb) => s.lstat(src, cb));
      if (st.isDirectory()) {
        plan.push({ src, dst, dir: true, size: 0 });
        for (const c of await this.list(src)) await walk(posix.join(src, c.name), pathJoin(dst, c.name));
      } else if (st.isFile()) {
        plan.push({ src, dst, dir: false, size: st.size });
      }
    };
    for (const remote of remotes) {
      const dst = pathJoin(localDir, posix.basename(remote));
      const taken = await fsp.lstat(dst).then(() => true, () => false);
      if (taken && !(await confirmOverwrite(posix.basename(remote)))) continue;
      await walk(remote, dst);
    }
    return this.transferAll(plan, 'down', onProgress);
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
