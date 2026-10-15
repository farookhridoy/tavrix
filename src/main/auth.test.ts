import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo, createServer } from 'node:net';
import { Server, utils } from 'ssh2';
import type { AuthenticationType } from 'ssh2';
import { Session, SecretPrompt, AuthFailedError, ConnectCancelledError } from './ssh';

type Mode = 'password' | 'keyboard' | 'publickey-only';

/** An SSH server that records every TCP connection and every login method it was offered. */
function startServer(mode: Mode, right = 'right') {
  const { private: hk } = utils.generateKeyPairSync('ed25519');
  const log = { connections: 0, methods: [] as string[], wrong: 0, loggedIn: 0 };
  const server = new Server({ hostKeys: [hk] }, (c) => {
    log.connections++;
    c.on('authentication', (ctx) => {
      log.methods.push(ctx.method);
      const offered: AuthenticationType[] = mode === 'password' ? ['password'] : mode === 'keyboard' ? ['keyboard-interactive'] : ['publickey'];
      if (mode === 'password' && ctx.method === 'password') {
        if (ctx.password === right) return ctx.accept();
        log.wrong++;
      } else if (mode === 'keyboard' && ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (answers[0] === right) return ctx.accept();
          log.wrong++;
          ctx.reject(offered);
        });
      }
      ctx.reject(offered);
    });
    c.on('ready', () => log.loggedIn++);
    c.on('error', () => {});
  });
  return new Promise<{ port: number; log: typeof log; stop: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, log, stop: () => server.close() })),
  );
}

const yes = async () => true;
const script = (answers: (string | null)[]) => {
  const asked: { label: string; previousFailed: boolean; secret: boolean }[] = [];
  const prompt: SecretPrompt = async (q) => (asked.push(q), answers.shift() ?? null);
  return { prompt, asked };
};
const login = (port: number, prompt: SecretPrompt, password?: string, connectTimeoutSec?: number) => {
  const s = new Session();
  return { s, done: s.connect({ host: '127.0.0.1', port, username: 'u', password, connectTimeoutSec }, yes, [], prompt) };
};

test('a password login uses ONE connection: no wasted probe, and the server is asked what it accepts first', async () => {
  const srv = await startServer('password');
  const { prompt, asked } = script(['right']);
  const { s, done } = login(srv.port, prompt);
  await done;
  assert.equal(srv.log.connections, 1);
  assert.deepEqual(srv.log.methods, ['none', 'password'], 'the "none" probe happens inside the same connection');
  assert.deepEqual(asked, [{ label: 'Password', previousFailed: false, secret: true }]);
  s.close(); srv.stop();
});

test('wrong passwords are retried on the same connection, then it stops after three', async () => {
  const srv = await startServer('password');
  let { prompt, asked } = script(['bad1', 'right']);
  let { s, done } = login(srv.port, prompt);
  await done;
  assert.equal(srv.log.connections, 1, 'one wrong password still costs just one connection');
  assert.equal(srv.log.wrong, 1);
  assert.deepEqual(asked.map((q) => q.previousFailed), [false, true], 'the second ask says the first failed');
  s.close();

  srv.log.connections = 0; srv.log.wrong = 0;
  ({ prompt, asked } = script(['a', 'b', 'c', 'never asked']));
  ({ s, done } = login(srv.port, prompt));
  await assert.rejects(done, (e) => e instanceof AuthFailedError && /Authentication failed/.test((e as Error).message));
  assert.equal(srv.log.connections, 1);
  assert.equal(srv.log.wrong, 3, 'exactly three attempts, as OpenSSH allows');
  assert.equal(asked.length, 3);
  srv.stop();
});

test('a saved password is tried first without asking; if it is wrong the user is asked, on the same connection', async () => {
  const srv = await startServer('password');
  let { prompt, asked } = script([]);
  let { s, done } = login(srv.port, prompt, 'right');
  await done;
  assert.equal(asked.length, 0, 'a correct saved password never prompts');
  assert.equal(srv.log.connections, 1);
  s.close();

  srv.log.connections = 0;
  ({ prompt, asked } = script(['right']));
  ({ s, done } = login(srv.port, prompt, 'stale-saved'));
  await done;
  assert.equal(srv.log.connections, 1);
  assert.deepEqual(asked.map((q) => q.previousFailed), [true], 'the saved one failed, so the prompt says so');
  s.close(); srv.stop();
});

test('cancelling the prompt stops cleanly and is reported as cancelled, not as a bad password', async () => {
  const srv = await startServer('password');
  const { prompt } = script([null]);
  const { done } = login(srv.port, prompt);
  await assert.rejects(done, ConnectCancelledError);
  assert.equal(srv.log.connections, 1);
  assert.equal(srv.log.wrong, 0, 'no password was ever sent');
  srv.stop();
});

test('servers that only offer keyboard-interactive work, with the password never sent as a plain "password" method', async () => {
  const srv = await startServer('keyboard');
  const { prompt, asked } = script(['bad', 'right']);
  const { s, done } = login(srv.port, prompt);
  await done;
  assert.equal(srv.log.connections, 1);
  assert.ok(!srv.log.methods.includes('password'));
  assert.deepEqual(srv.log.methods.filter((m) => m === 'keyboard-interactive').length, 2);
  assert.deepEqual(asked.map((q) => [q.label, q.secret, q.previousFailed]), [['Password', true, false], ['Password', true, true]]);
  s.close(); srv.stop();
});

test('a key-only server is explained instead of being hammered with passwords', async () => {
  const srv = await startServer('publickey-only');
  const { prompt, asked } = script(['whatever']);
  const { done } = login(srv.port, prompt);
  await assert.rejects(done, (e) => e instanceof AuthFailedError && /does not accept password login \(it offers: publickey\)/.test((e as Error).message));
  assert.equal(asked.length, 0, 'the user is not asked for a password the server cannot use');
  assert.deepEqual(srv.log.methods, ['none'], 'no password attempt at all');
  assert.equal(srv.log.connections, 1);
  srv.stop();
});

test('time spent typing a password does not count against the connect timeout, but a silent server still times out', async () => {
  const srv = await startServer('password');
  const slow: SecretPrompt = async () => (await new Promise((r) => setTimeout(r, 900)), 'right');
  const { s, done } = login(srv.port, slow, undefined, 0.4); // 400 ms limit, 900 ms to type
  await done;
  s.close(); srv.stop();

  const mute = createServer(() => {});
  const port = await new Promise<number>((r) => mute.listen(0, '127.0.0.1', () => r((mute.address() as AddressInfo).port)));
  const started = Date.now();
  const { done: silent } = login(port, async () => 'x', undefined, 0.4);
  await assert.rejects(silent, /timed out/i);
  assert.ok(Date.now() - started < 2500);
  mute.close();
});

test('time in the host-key dialog does not count against the timeout either', async () => {
  const srv = await startServer('password');
  const s = new Session();
  await s.connect({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'right', connectTimeoutSec: 0.4 }, async () => (await new Promise((r) => setTimeout(r, 900)), true));
  s.close(); srv.stop();
});
