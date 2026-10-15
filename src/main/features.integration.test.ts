import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, AddressInfo, Server as NetServer, Socket } from 'node:net';
import { Server, utils } from 'ssh2';
import { Session, JumpHostError } from './ssh';

// Real-server tests. Example: TAVRIX_TEST_SSH=127.0.0.1:2299:me:/path/to/key npm test
const target = process.env.TAVRIX_TEST_SSH;
const skip = target ? false : 'set TAVRIX_TEST_SSH=host:port:user:keyPath to run';
const cfg = () => {
  const [host, port, username, privateKeyPath] = (target as string).split(':');
  return { host, port: Number(port), username, privateKeyPath };
};
const yes = async () => true;

function echoServer(): Promise<{ server: NetServer; port: number }> {
  const server = createServer((s) => s.pipe(s));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as AddressInfo).port })));
}

function roundTrip(port: number, payload: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, host, () => s.write(payload));
    s.once('data', (d: Buffer) => (s.destroy(), resolve(d.toString())));
    s.once('error', reject);
    setTimeout(() => (s.destroy(), reject(new Error('timeout'))), 4000);
  });
}

test('local forward (-L) carries traffic through the server', { skip }, async () => {
  const echo = await echoServer();
  const s = new Session();
  await s.connect(cfg(), yes);
  try {
    const f = await s.forwards.start({ kind: 'local', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echo.port });
    assert.ok(f.bindPort > 0);
    assert.equal(await roundTrip(f.bindPort, 'hello-L'), 'hello-L');
    assert.equal(s.forwards.list().length, 1);
    await s.forwards.stop(f.id);
    assert.equal(s.forwards.list().length, 0);
    await assert.rejects(roundTrip(f.bindPort, 'x'), 'the port is closed after stopping');
  } finally {
    s.close();
    echo.server.close();
  }
});

test('remote forward (-R) exposes a local service on the server', { skip }, async () => {
  const echo = await echoServer();
  const s = new Session();
  await s.connect(cfg(), yes);
  try {
    const f = await s.forwards.start({ kind: 'remote', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echo.port });
    assert.ok(f.bindPort > 0, 'the server chose a port');
    assert.equal(await roundTrip(f.bindPort, 'hello-R'), 'hello-R');
    await s.forwards.stop(f.id);
  } finally {
    s.close();
    echo.server.close();
  }
});

function socksConnect(socksPort: number, addr: number[], payload: string): Promise<{ reply: number; echoed: string }> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect(socksPort, '127.0.0.1');
    let stage = 0;
    let reply = -1;
    s.on('data', (d: Buffer) => {
      if (stage === 0) {
        assert.deepEqual([...d], [5, 0]);
        stage = 1;
        s.write(Buffer.from([5, 1, 0, 1, ...addr]));
      } else if (stage === 1) {
        reply = d[1];
        if (reply !== 0) return void (s.destroy(), resolve({ reply, echoed: '' }));
        stage = 2;
        s.write(payload);
      } else {
        s.destroy();
        resolve({ reply, echoed: d.toString() });
      }
    });
    s.on('error', reject);
    s.write(Buffer.from([5, 1, 0]));
    setTimeout(() => (s.destroy(), reject(new Error('timeout'))), 4000);
  });
}

test('dynamic forward (-D) speaks SOCKS5 and reports refused connections', { skip }, async () => {
  const echo = await echoServer();
  const s = new Session();
  await s.connect(cfg(), yes);
  try {
    const f = await s.forwards.start({ kind: 'dynamic', bindHost: '127.0.0.1', bindPort: 0 });
    const port = Buffer.alloc(2);
    port.writeUInt16BE(echo.port);
    const ok = await socksConnect(f.bindPort, [127, 0, 0, 1, ...port], 'hello-D');
    assert.deepEqual(ok, { reply: 0, echoed: 'hello-D' });
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const deadPort = (closed.address() as AddressInfo).port;
    closed.close();
    const dp = Buffer.alloc(2);
    dp.writeUInt16BE(deadPort);
    const refused = await socksConnect(f.bindPort, [127, 0, 0, 1, ...dp], 'x');
    assert.equal(refused.reply, 5, 'connection refused');
  } finally {
    s.close();
    echo.server.close();
  }
});

test('forward validation: ports and destinations are checked', { skip }, async () => {
  const s = new Session();
  await s.connect(cfg(), yes);
  try {
    await assert.rejects(s.forwards.start({ kind: 'local', bindHost: '127.0.0.1', bindPort: 70000, destHost: 'a', destPort: 1 }), /Invalid port/);
    await assert.rejects(s.forwards.start({ kind: 'local', bindHost: '127.0.0.1', bindPort: 0 }), /destination/);
  } finally {
    s.close();
  }
});

test('jump host: the destination is reached through the jump, with each host key verified', { skip }, async () => {
  const { private: hostKey } = utils.generateKeyPairSync('ed25519');
  const dest = new Server({ hostKeys: [hostKey] }, (c) => {
    c.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject()));
    c.on('error', () => {});
  });
  const destPort = await new Promise<number>((r) => dest.listen(0, '127.0.0.1', () => r((dest.address() as AddressInfo).port)));
  const seen: string[] = [];
  const s = new Session();
  try {
    await s.connect(
      { host: '127.0.0.1', port: destPort, username: 'u', password: 'pw' },
      async (h) => (seen.push('dest:' + h), true),
      [{ req: cfg(), verify: async (h) => (seen.push('jump:' + h), true) }],
    );
    assert.equal(seen.length, 2);
    assert.ok(seen[0].startsWith('jump:'), 'the jump host is verified first');
    assert.ok(seen[1].startsWith('dest:'));
    assert.notEqual(seen[0].slice(5), seen[1].slice(5), 'two different host keys');
  } finally {
    s.close();
    dest.close();
  }
});

test('jump host failures are labelled and leave nothing connected', { skip }, async () => {
  const s = new Session();
  await assert.rejects(
    s.connect({ host: '127.0.0.1', port: 9, username: 'u', password: 'x' }, yes, [
      { req: { ...cfg(), privateKeyPath: undefined, password: 'wrong' }, verify: yes },
    ]),
    (e) => e instanceof JumpHostError && /^Jump host /.test((e as Error).message),
  );
  const s2 = new Session();
  await assert.rejects(s2.connect({ host: '127.0.0.1', port: 9, username: 'u', password: 'x' }, yes, [{ req: cfg(), verify: async () => false }]), JumpHostError);
});

test('several shells share one connection and stay independent', { skip }, async () => {
  const s = new Session();
  await s.connect(cfg(), yes);
  const out = new Map<string, string>();
  const closed: string[] = [];
  const onData = (id: string, d: string): void => void out.set(id, (out.get(id) ?? '') + d);
  try {
    const a = await s.openShell(80, 24, onData, (id) => closed.push(id));
    const b = await s.openShell(80, 24, onData, (id) => closed.push(id));
    assert.notEqual(a, b);
    assert.equal(s.shellCount(), 2);
    s.write(a, 'echo MARK_$((40+2))_A\n');
    s.write(b, 'echo MARK_$((50+5))_B\n');
    await new Promise((r) => setTimeout(r, 1500));
    assert.match(out.get(a) ?? '', /MARK_42_A/);
    assert.match(out.get(b) ?? '', /MARK_55_B/);
    assert.doesNotMatch(out.get(a) ?? '', /MARK_55_B/);
    assert.doesNotMatch(out.get(b) ?? '', /MARK_42_A/);
    s.closeShell(a);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(closed, [a]);
    assert.equal(s.shellCount(), 1);
    s.write(b, 'echo STILL_$((1+1))\n');
    await new Promise((r) => setTimeout(r, 800));
    assert.match(out.get(b) ?? '', /STILL_2/);
  } finally {
    s.close();
  }
});

test('connection options: keep-alive, compression and timeout are accepted and the connection stays usable', { skip }, async () => {
  const s = new Session();
  await s.connect({ ...cfg(), keepAliveSec: 1, compression: true, connectTimeoutSec: 10 }, yes);
  try {
    // idle for several keep-alive periods: the server must answer the probes, or the client would close the link
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok((await s.list(await s.realpath('.'))).length > 0, 'still connected after idling');
    const f = await s.forwards.start({ kind: 'dynamic', bindHost: '127.0.0.1', bindPort: 0 });
    assert.ok(f.bindPort > 0, 'other features work on a compressed connection');
  } finally {
    s.close();
  }
  const off = new Session();
  await off.connect({ ...cfg(), keepAliveSec: 0 }, yes);
  assert.ok(await off.realpath('.'), 'keep-alive 0 (off) also connects');
  off.close();
});

test('a connection that cannot be completed in time fails instead of hanging', { skip }, async () => {
  // a server that accepts the TCP connection and then says nothing
  const mute = createServer(() => {});
  const port = await new Promise<number>((r) => mute.listen(0, '127.0.0.1', () => r((mute.address() as AddressInfo).port)));
  const s = new Session();
  const started = Date.now();
  await assert.rejects(s.connect({ host: '127.0.0.1', port, username: 'u', password: 'x', connectTimeoutSec: 5 }, yes), /timed out|timeout|handshake/i);
  assert.ok(Date.now() - started < 9000, 'gave up after about 5 seconds');
  mute.close();
});
