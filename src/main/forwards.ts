import { createServer, connect, Server, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';
import { parseGreeting, parseRequest, socksReply, REPLY } from './socks';

export type ForwardKind = 'local' | 'remote' | 'dynamic';

export interface ForwardSpec {
  kind: ForwardKind;
  /** local: address to listen on locally; remote: address to listen on at the server; dynamic: local SOCKS address. */
  bindHost: string;
  /** 0 picks a free port. */
  bindPort: number;
  /** local: target as seen from the server; remote: target as seen from this Mac. Unused for dynamic. */
  destHost?: string;
  destPort?: number;
}

export interface ForwardInfo {
  id: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  destHost?: string;
  destPort?: number;
  description: string;
}

interface Active {
  info: ForwardInfo;
  stop: () => Promise<void>;
}

function pipe(a: Socket | ClientChannel, b: Socket | ClientChannel): void {
  a.pipe(b);
  b.pipe(a);
  const end = (): void => {
    a.destroy();
    b.destroy();
  };
  a.on('error', end);
  b.on('error', end);
  a.on('close', end);
  b.on('close', end);
}

function describe(s: ForwardSpec, port: number): string {
  if (s.kind === 'dynamic') return `SOCKS5 ${s.bindHost}:${port}`;
  if (s.kind === 'local') return `${s.bindHost}:${port} → ${s.destHost}:${s.destPort} (via server)`;
  return `server ${s.bindHost}:${port} → ${s.destHost}:${s.destPort} (on this Mac)`;
}

/** Port forwards that run over one SSH connection. */
export class Forwards {
  private active = new Map<string, Active>();
  /** remote forwards by the port the server is listening on */
  private remote = new Map<number, { host: string; port: number }>();

  constructor(private client: Client) {
    client.on('tcp connection', (details, accept, reject) => {
      const dest = this.remote.get(details.destPort);
      if (!dest) return reject();
      const channel = accept();
      const sock = connect(dest.port, dest.host);
      sock.on('connect', () => pipe(channel, sock));
      sock.on('error', () => channel.destroy());
    });
  }

  list(): ForwardInfo[] {
    return [...this.active.values()].map((a) => a.info);
  }

  async start(spec: ForwardSpec): Promise<ForwardInfo> {
    if (spec.kind !== 'dynamic' && (!spec.destHost || !spec.destPort)) throw new Error('A destination host and port are required');
    for (const p of [spec.bindPort, spec.destPort ?? 0]) {
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`Invalid port: ${p}`);
    }
    if (spec.kind === 'remote') return this.startRemote(spec);
    return this.startListening(spec);
  }

  private startListening(spec: ForwardSpec): Promise<ForwardInfo> {
    const server: Server = createServer((sock) => {
      if (spec.kind === 'dynamic') this.socks(sock);
      else this.toDest(sock, spec.destHost as string, spec.destPort as number);
    });
    const sockets = new Set<Socket>();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(spec.bindPort, spec.bindHost, () => {
        const port = (server.address() as { port: number }).port;
        const info: ForwardInfo = { id: randomUUID(), ...spec, bindPort: port, description: describe(spec, port) };
        this.active.set(info.id, {
          info,
          stop: () =>
            new Promise((done) => {
              for (const s of sockets) s.destroy();
              server.close(() => done());
            }),
        });
        resolve(info);
      });
    });
  }

  private toDest(sock: Socket, host: string, port: number): void {
    sock.on('error', () => {});
    this.client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, host, port, (err, channel) => {
      if (err) return sock.destroy();
      pipe(sock, channel);
    });
  }

  private socks(sock: Socket): void {
    sock.on('error', () => {});
    let phase: 'greeting' | 'request' = 'greeting';
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024) return void sock.destroy(); // handshakes are tiny; refuse anything else
      if (phase === 'greeting') {
        const g = parseGreeting(buf);
        if (g.state === 'need-more') return;
        if (g.state === 'error') return void sock.end(Buffer.from([5, g.reply]));
        sock.write(Buffer.from([5, 0]));
        buf = buf.subarray(g.consumed);
        phase = 'request';
      }
      const r = parseRequest(buf);
      if (r.state === 'need-more') return;
      sock.off('data', onData);
      if (r.state === 'error') return void sock.end(socksReply(r.reply));
      const rest = buf.subarray(r.consumed);
      sock.pause();
      this.client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, r.value.host, r.value.port, (err, channel) => {
        if (err) return void sock.end(socksReply(/refused/i.test(err.message) ? REPLY.refused : REPLY.hostUnreachable));
        sock.write(socksReply(REPLY.ok));
        if (rest.length) channel.write(rest);
        pipe(sock, channel);
        sock.resume();
      });
    };
    sock.on('data', onData);
  }

  private startRemote(spec: ForwardSpec): Promise<ForwardInfo> {
    return new Promise((resolve, reject) => {
      this.client.forwardIn(spec.bindHost, spec.bindPort, (err, port) => {
        if (err) return reject(err);
        const bound = port || spec.bindPort;
        this.remote.set(bound, { host: spec.destHost as string, port: spec.destPort as number });
        const info: ForwardInfo = { id: randomUUID(), ...spec, bindPort: bound, description: describe(spec, bound) };
        this.active.set(info.id, {
          info,
          stop: () =>
            new Promise((done) => {
              this.remote.delete(bound);
              this.client.unforwardIn(spec.bindHost, bound, () => done());
            }),
        });
        resolve(info);
      });
    });
  }

  async stop(id: string): Promise<void> {
    const a = this.active.get(id);
    if (!a) return;
    this.active.delete(id);
    await a.stop();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }
}
