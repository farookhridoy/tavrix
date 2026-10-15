import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from './ssh';

// Runs against a real SSH server. Example:
//   TAVRIX_TEST_SSH=127.0.0.1:2299:me:/path/to/key npm test
const target = process.env.TAVRIX_TEST_SSH;
const skip = target ? false : 'set TAVRIX_TEST_SSH=host:port:user:keyPath to run';

test('SFTP file operations against a real server', { skip }, async () => {
  const [host, port, username, privateKeyPath] = (target as string).split(':');
  const s = new Session();
  await s.connect({ host, port: Number(port), username, privateKeyPath }, async () => true);
  const home = await s.realpath('.');
  const root = `${home}/tavrix-it-${process.pid}`;
  const local = mkdtempSync(join(tmpdir(), 'tavrix-it-'));
  try {
    await s.mkdir(root);

    // upload a folder tree and a file
    mkdirSync(join(local, 'proj/sub'), { recursive: true });
    writeFileSync(join(local, 'proj/a.txt'), 'hello');
    writeFileSync(join(local, 'proj/sub/b.txt'), 'world');
    writeFileSync(join(local, 'solo.txt'), 'x'.repeat(100000));
    const seen: number[] = [];
    const up = await s.upload([join(local, 'proj'), join(local, 'solo.txt')], root, (p) => seen.push(p.done), async () => true);
    assert.equal(up.files, 3);
    assert.equal(up.bytes, 100010);
    assert.equal(seen.at(-1), 100010);
    assert.equal(await s.readFile(`${root}/proj/sub/b.txt`), 'world');

    // listing: dirs first, mode present
    const names = (await s.list(root)).map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`);
    assert.deepEqual(names, ['d:proj', 'f:solo.txt']);

    // overwrite declined leaves the remote file untouched
    writeFileSync(join(local, 'proj/a.txt'), 'changed');
    await s.upload([join(local, 'proj')], root, () => {}, async () => false);
    assert.equal(await s.readFile(`${root}/proj/a.txt`), 'hello');

    // rename, collision refused, chmod
    await s.rename(`${root}/solo.txt`, `${root}/renamed.txt`);
    await assert.rejects(s.rename(`${root}/renamed.txt`, `${root}/proj`), /already exists/);
    await s.chmod(`${root}/renamed.txt`, 0o600);
    const renamed = (await s.list(root)).find((e) => e.name === 'renamed.txt');
    assert.equal(renamed?.mode, 0o600);

    // download the folder back
    const dest = mkdtempSync(join(tmpdir(), 'tavrix-dl-'));
    const down = await s.download([`${root}/proj`], dest, () => {}, async () => true);
    assert.equal(down.files, 2);
    assert.equal(readFileSync(join(dest, 'proj/sub/b.txt'), 'utf8'), 'world');
    rmSync(dest, { recursive: true });

    // recursive delete, and the root guard
    await s.remove(`${root}/proj`);
    assert.equal(await s.exists(`${root}/proj`), false);
    await assert.rejects(s.remove('/'), /Refusing/);
  } finally {
    await s.remove(root).catch(() => {});
    rmSync(local, { recursive: true, force: true });
    s.close();
  }
  assert.ok(!existsSync(local));
});
