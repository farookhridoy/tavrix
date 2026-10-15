import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import { Session } from './ssh';

function startServer(): Promise<{ server: Server; port: number }> {
  const { private: hostKey } = utils.generateKeyPairSync('ed25519');
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
  writeFileSync(enc, utils.generateKeyPairSync('ed25519', { passphrase: 'pw 1', cipher: 'aes256-ctr', rounds: 8 }).private);
  writeFileSync(plain, utils.generateKeyPairSync('ed25519').private);
  writeFileSync(junk, 'not a key');

  assert.ok(loadPrivateKey(plain));
  assert.ok(loadPrivateKey(enc, 'pw 1'));
  assert.throws(() => loadPrivateKey(enc), (e) => e instanceof KeyPassphraseError && e.reason === 'required');
  assert.throws(() => loadPrivateKey(enc, 'nope'), (e) => e instanceof KeyPassphraseError && e.reason === 'wrong');
  assert.throws(() => loadPrivateKey(junk), (e) => !(e instanceof KeyPassphraseError) && /Cannot read private key/.test((e as Error).message));
});
