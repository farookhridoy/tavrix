import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig } from './sshconfig';

test('parses concrete hosts and skips wildcards', () => {
  const cfg = `
Host *
  ServerAliveInterval 30
Host web db
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
Host plain
`;
  const hosts = parseSshConfig(cfg, '/Users/me');
  assert.deepEqual(hosts.map((h) => h.alias), ['web', 'db', 'plain']);
  assert.equal(hosts[0].host, '10.0.0.5');
  assert.equal(hosts[0].port, 2222);
  assert.equal(hosts[0].username, 'deploy');
  assert.equal(hosts[0].privateKeyPath, '/Users/me/.ssh/id_ed25519');
  assert.equal(hosts[2].host, 'plain');
  assert.equal(hosts[2].port, 22);
});
