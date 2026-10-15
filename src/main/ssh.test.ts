import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import { Session } from './ssh';
import { makeKeyPair } from './test-keys';

function startServer(): Promise<{ server: Server; port: number }> {
  const { private: hostKey } = makeKeyPair();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject()));
    client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

const req = (port: number, password: string) => ({ host: '127.0.0.1', port, username: 'u', password });

test('connects when the host key is trusted and passes a sha256 hex fingerprint', async () => {
  const { server, port } = await startServer();
  let seen = '';
  const s = new Session();
  await s.connect(req(port, 'pw'), async (hex) => ((seen = hex), true));
  assert.match(seen, /^[0-9a-f]{64}$/);
  s.close();
  server.close();
});

test('refuses to connect when the host key is rejected', async () => {
  const { server, port } = await startServer();
  const s = new Session();
  await assert.rejects(s.connect(req(port, 'pw'), async () => false));
  server.close();
});

test('fails authentication with a wrong password', async () => {
  const { server, port } = await startServer();
  const s = new Session();
  await assert.rejects(s.connect(req(port, 'bad'), async () => true));
  server.close();
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrivateKey, KeyPassphraseError } from './ssh';

test('loadPrivateKey distinguishes missing and wrong passphrases from unreadable keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavrix-key-'));
  const enc = join(dir, 'enc');
  const plain = join(dir, 'plain');
  const junk = join(dir, 'junk');
  writeFileSync(enc, makeKeyPair({ passphrase: 'pw 1', cipher: 'aes256-ctr', rounds: 8 }).private);
  writeFileSync(plain, makeKeyPair().private);
  writeFileSync(junk, 'not a key');

  assert.ok(loadPrivateKey(plain));
  assert.ok(loadPrivateKey(enc, 'pw 1'));
  assert.throws(() => loadPrivateKey(enc), (e) => e instanceof KeyPassphraseError && e.reason === 'required');
  assert.throws(() => loadPrivateKey(enc, 'nope'), (e) => e instanceof KeyPassphraseError && e.reason === 'wrong');
  assert.throws(() => loadPrivateKey(junk), (e) => !(e instanceof KeyPassphraseError) && /Cannot read private key/.test((e as Error).message));
});

import { inspectKeyFile, expandHome } from './ssh';
import { homedir } from 'node:os';

test('key files are recognised without reading their contents back, and ~ means the home folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavrix-keyfiles-'));
  const pair = makeKeyPair();
  const enc = makeKeyPair({ passphrase: 'pw', cipher: 'aes256-ctr', rounds: 8 });
  const files: Record<string, string> = { priv: pair.private, pub: pair.public, enc: enc.private, junk: 'hello world' };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, 'huge'), 'x'.repeat(70 * 1024));

  assert.deepEqual(inspectKeyFile(join(dir, 'priv')), { kind: 'private', type: 'ssh-ed25519' });
  assert.deepEqual(inspectKeyFile(join(dir, 'enc')), { kind: 'private-encrypted' });
  assert.deepEqual(inspectKeyFile(join(dir, 'pub')), { kind: 'public' });
  assert.equal(inspectKeyFile(join(dir, 'junk')).kind, 'invalid');
  assert.equal(inspectKeyFile(join(dir, 'huge')).kind, 'invalid');
  assert.deepEqual(inspectKeyFile(join(dir, 'nope')), { kind: 'invalid', message: 'File not found' });
  assert.equal(inspectKeyFile(dir).kind, 'invalid', 'a folder is not a key');
  assert.ok(!JSON.stringify(inspectKeyFile(join(dir, 'priv'))).includes('PRIVATE KEY'), 'never returns key material');

  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/.ssh/id'), join(homedir(), '.ssh/id'));
  assert.equal(expandHome('/abs/~/x'), '/abs/~/x');
  assert.equal(expandHome('~other/x'), '~other/x', 'only the current user shorthand is expanded');
  assert.ok(loadPrivateKey(join(dir, 'priv')), 'a plain path still loads');
});

test('the test key helper never hands out a key that cannot be read back', () => {
  for (let i = 0; i < 1500; i++) assert.ok(!(utils.parseKey(makeKeyPair().private) instanceof Error), `key #${i}`);
  const enc = makeKeyPair({ passphrase: 'pw', cipher: 'aes256-ctr', rounds: 8 });
  assert.ok(!(utils.parseKey(enc.private, 'pw') instanceof Error));
});
