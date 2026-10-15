import { Client, ClientChannel, SFTPWrapper, FileEntryWithStats, utils } from 'ssh2';
import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { posix, join as pathJoin, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { Forwards } from './forwards';

/** The private key is encrypted and needs a passphrase ('required'), or the one given did not decrypt it ('wrong'). */
export class KeyPassphraseError extends Error {
  constructor(readonly reason: 'required' | 'wrong') {
    super(reason === 'required' ? 'The private key is encrypted and needs a passphrase' : 'Wrong passphrase for the private key');
    this.name = 'KeyPassphraseError';
  }
}

/** Read and validate a private key file, distinguishing a missing/wrong passphrase from an unreadable key. */
export function loadPrivateKey(path: string, passphrase?: string): Buffer {
  const data = readFileSync(path);
  const parsed = utils.parseKey(data, passphrase || undefined);
  if (!(parsed instanceof Error)) return data;
  if (/no passphrase given/i.test(parsed.message)) throw new KeyPassphraseError('required');
  if (passphrase && /(bad passphrase|passphrase|decrypt)/i.test(parsed.message)) throw new KeyPassphraseError('wrong');
  throw new Error(`Cannot read private key ${path}: ${parsed.message}`);
}

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

export interface FileStat {
  size: number;
  mtime: number;
  mode: number;
}

export type SaveResult = { conflict: false; stat: FileStat | null } | { conflict: true; stat: FileStat | null };

/** Largest file the editor will open; bigger files are for download. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

export interface Progress {
  name: string;
  done: number;
  total: number;
}

export interface TransferResult {
  files: number;
  bytes: number;
  cancelled: boolean;
}

export type OnProgress = (p: Progress) => void;
/** Asked once per top-level item that already exists at the destination. */
export type ConfirmOverwrite = (name: string) => Promise<boolean>;

/** One hop to pass through before the final host (OpenSSH ProxyJump). */
export interface Hop {
  req: ConnectRequest;
  verify: (sha256Hex: string) => Promise<boolean>;
}

/** A failure on a jump host rather than the destination; never a prompt-for-secret case. */
export class JumpHostError extends Error {
  constructor(hop: ConnectRequest, cause: unknown) {
    super(`Jump host ${hop.username}@${hop.host}:${hop.port}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'JumpHostError';
  }
}

function connectClient(
  client: Client,
  req: ConnectRequest,
  verifyHost: (sha256Hex: string) => Promise<boolean>,
  sock?: Duplex,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.connect({
      host: req.host,
      port: req.port,
      username: req.username,
      password: req.password,
      privateKey: req.privateKeyPath ? loadPrivateKey(req.privateKeyPath, req.passphrase) : undefined,
      passphrase: req.passphrase,
      sock,
      readyTimeout: 20000,
      hostHash: 'sha256',
      // ssh2 uses the callback when the function returns undefined.
      hostVerifier: ((hash: string, cb: (ok: boolean) => void): undefined => {
        verifyHost(hash).then(cb, () => cb(false));
      }) as unknown as (hash: string) => boolean,
    });
  });
}

export class Session {
  private client = new Client();
  private jumpClients: Client[] = [];
  private shells = new Map<string, ClientChannel>();
  private sftpHandle?: SFTPWrapper;
  private cancelled = false;
  readonly forwards = new Forwards(this.client);

  /** Connect to req, passing through each hop in order (outermost first). */
  async connect(req: ConnectRequest, verifyHost: Hop['verify'], jumps: Hop[] = []): Promise<void> {
    const chain: Hop[] = [...jumps, { req, verify: verifyHost }];
    let via: Client | undefined;
    try {
      for (let i = 0; i < chain.length; i++) {
        const hop = chain[i];
        const last = i === chain.length - 1;
        const client = last ? this.client : new Client();
        if (!last) this.jumpClients.push(client);
        try {
          const sock = via ? await this.openChannel(via, hop.req) : undefined;
          await connectClient(client, hop.req, hop.verify, sock);
        } catch (err) {
          throw last ? err : new JumpHostError(hop.req, err);
        }
        via = client;
      }
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private openChannel(via: Client, to: ConnectRequest): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      via.forwardOut('127.0.0.1', 0, to.host, to.port, (err, channel) => (err ? reject(err) : resolve(channel)));
    });
  }

  /** Called once if the connection to the destination ends (dropped or closed). */
  onDisconnect(cb: () => void): void {
    this.client.once('close', cb);
  }

  openShell(
    cols: number,
    rows: number,
    onData: (shellId: string, d: string) => void,
    onClose: (shellId: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err);
        const id = randomUUID();
        this.shells.set(id, stream);
        stream.on('data', (d: Buffer) => onData(id, d.toString('utf8')));
        stream.on('close', () => {
          this.shells.delete(id);
          onClose(id);
        });
        resolve(id);
      });
    });
  }

  shellCount(): number {
    return this.shells.size;
  }

  write(shellId: string, data: string): void {
    this.shells.get(shellId)?.write(data);
  }

  resize(shellId: string, cols: number, rows: number): void {
    this.shells.get(shellId)?.setWindow(rows, cols, 0, 0);
  }

  closeShell(shellId: string): void {
    this.shells.get(shellId)?.close();
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpHandle) return Promise.resolve(this.sftpHandle);
    return new Promise((resolve, reject) => {
      this.client.sftp((err, s) => {
        if (err) return reject(err);
        this.sftpHandle = s;
        s.once('close', () => {
          if (this.sftpHandle === s) this.sftpHandle = undefined;
        });
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
    plan: { src: string; dst: string; dir: boolean; size: number; mode?: number }[],
    kind: 'up' | 'down',
    onProgress: OnProgress,
  ): Promise<TransferResult> {
    this.cancelled = false;
    const total = plan.reduce((n, p) => n + p.size, 0);
    let done = 0;
    let files = 0;
    for (const p of plan) {
      if (this.cancelled) break;
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
      try {
        await this.call<void>((s, cb) => {
          const opts = { step: (t: number) => onProgress({ name, done: base + t, total }), mode: p.mode };
          if (kind === 'up') s.fastPut(p.src, p.dst, opts, (e) => cb(e));
          else s.fastGet(p.src, p.dst, opts, (e) => cb(e));
        });
        // fastGet creates local files with default permissions; keep the remote ones (e.g. an executable script).
        if (kind === 'down' && p.mode !== undefined) await fsp.chmod(p.dst, p.mode);
      } catch (err) {
        if (!this.cancelled) throw err;
        // Cancelled mid-file: the SFTP channel was closed, so remove the partial destination.
        if (kind === 'down') await fsp.rm(p.dst, { force: true });
        else await this.remove(p.dst).catch(() => {});
        break;
      }
      done += p.size;
      files++;
      onProgress({ name, done, total });
    }
    return { files, bytes: done, cancelled: this.cancelled };
  }

  /** Abort the running transfer: stop after the current file and close the SFTP channel to interrupt it. */
  cancelTransfer(): void {
    this.cancelled = true;
    this.sftpHandle?.end();
    this.sftpHandle = undefined;
  }

  /** Upload local files/folders into remoteDir. Symlinks are skipped. */
  async upload(
    locals: string[],
    remoteDir: string,
    onProgress: OnProgress,
    confirmOverwrite: ConfirmOverwrite,
  ): Promise<TransferResult> {
    const plan: { src: string; dst: string; dir: boolean; size: number; mode?: number }[] = [];
    const walk = async (src: string, dst: string): Promise<void> => {
      const st = await fsp.lstat(src);
      if (st.isDirectory()) {
        plan.push({ src, dst, dir: true, size: 0 });
        for (const n of await fsp.readdir(src)) await walk(pathJoin(src, n), posix.join(dst, n));
      } else if (st.isFile()) {
        plan.push({ src, dst, dir: false, size: st.size, mode: st.mode & 0o777 });
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
  ): Promise<TransferResult> {
    const plan: { src: string; dst: string; dir: boolean; size: number; mode?: number }[] = [];
    const walk = async (src: string, dst: string): Promise<void> => {
      const st = await this.call<import('ssh2').Stats>((s, cb) => s.lstat(src, cb));
      if (st.isDirectory()) {
        plan.push({ src, dst, dir: true, size: 0 });
        for (const c of await this.list(src)) await walk(posix.join(src, c.name), pathJoin(dst, c.name));
      } else if (st.isFile()) {
        plan.push({ src, dst, dir: false, size: st.size, mode: st.mode & 0o777 });
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

  /** Size, modification time (seconds) and permission bits; null when the path does not exist. */
  async stat(path: string): Promise<FileStat | null> {
    try {
      const st = await this.call<import('ssh2').Stats>((s, cb) => s.stat(path, cb));
      return { size: st.size, mtime: st.mtime, mode: st.mode & 0o7777 };
    } catch (err) {
      if ((err as { code?: number }).code === 2) return null; // SFTP NO_SUCH_FILE
      throw err;
    }
  }

  /** Create an empty file (0644). Fails if it already exists. */
  async createFile(path: string): Promise<void> {
    const handle = await this.call<Buffer>((s, cb) => s.open(path, 'wx', 0o644, cb));
    await this.call<void>((s, cb) => s.close(handle, (e) => cb(e)));
  }

  /** Read a text file for editing. Refuses files that would not survive a text round trip. */
  async readFile(path: string): Promise<string> {
    const st = await this.stat(path);
    if (!st) throw new Error(`${path} does not exist`);
    if (st.size > MAX_EDIT_BYTES) {
      throw new Error(`This file is ${(st.size / 1048576).toFixed(1)} MB, too large to edit here (limit ${MAX_EDIT_BYTES / 1048576} MB). Download it instead.`);
    }
    const s = await this.sftp();
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      s.createReadStream(path)
        .on('data', (c: Buffer) => chunks.push(c))
        .on('error', reject)
        .on('end', () => resolve(Buffer.concat(chunks)));
    });
    if (buf.includes(0)) throw new Error('This looks like a binary file; saving it as text would corrupt it. Download it instead.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new Error('This file is not valid UTF-8 text; saving it would corrupt it. Download it instead.');
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.writeFile(path, Buffer.from(content, 'utf8'), (e) => (e ? reject(e) : resolve()));
    });
  }

  /**
   * Save unless the file changed (or vanished) since `expected` was recorded. `force` skips the check.
   * The check and the write are separate SFTP calls, so a change landing in between is still possible.
   */
  async saveFile(path: string, content: string, expected: FileStat | undefined, force: boolean): Promise<SaveResult> {
    if (!force && expected) {
      const cur = await this.stat(path);
      if (!cur || cur.size !== expected.size || cur.mtime !== expected.mtime) return { conflict: true, stat: cur };
    }
    await this.writeFile(path, content);
    return { conflict: false, stat: await this.stat(path) };
  }

  close(): void {
    void this.forwards.closeAll();
    this.client.end();
    for (const c of this.jumpClients) c.end();
    this.jumpClients = [];
  }
}
