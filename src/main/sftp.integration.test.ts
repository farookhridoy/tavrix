import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
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

    // executable scripts keep their executable bit in both directions
    writeFileSync(join(local, 'run.sh'), '#!/bin/bash\necho ok\n', { mode: 0o755 });
    await s.upload([join(local, 'run.sh')], root, () => {}, async () => true);
    assert.equal((await s.list(root)).find((e) => e.name === 'run.sh')?.mode, 0o755, 'upload keeps 755');
    const dest0 = mkdtempSync(join(tmpdir(), 'tavrix-dl0-'));
    await s.download([`${root}/run.sh`], dest0, () => {}, async () => true);
    assert.equal(statSync(join(dest0, 'run.sh')).mode & 0o777, 0o755, 'download keeps 755');
    rmSync(dest0, { recursive: true });

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

test('cancelling an upload removes the partial file and keeps the session usable', { skip }, async () => {
  const [host, port, username, privateKeyPath] = (target as string).split(':');
  const s = new Session();
  await s.connect({ host, port: Number(port), username, privateKeyPath }, async () => true);
  const home = await s.realpath('.');
  const root = `${home}/tavrix-cancel-${process.pid}`;
  const local = mkdtempSync(join(tmpdir(), 'tavrix-cancel-'));
  try {
    await s.mkdir(root);
    const big = join(local, 'big.bin');
    writeFileSync(big, Buffer.alloc(300 * 1024 * 1024, 7));
    const res = await s.upload([big], root, (p) => { if (p.done > 0 && p.done < p.total) s.cancelTransfer(); }, async () => true);
    assert.equal(res.cancelled, true);
    assert.equal(res.files, 0);
    assert.equal(await s.exists(`${root}/big.bin`), false, 'partial file must be removed');
    // the session still works, and a following transfer is not poisoned by the old cancel
    writeFileSync(join(local, 'small.txt'), 'ok');
    const again = await s.upload([join(local, 'small.txt')], root, () => {}, async () => true);
    assert.equal(again.cancelled, false);
    assert.equal(await s.readFile(`${root}/small.txt`), 'ok');
  } finally {
    await s.remove(root).catch(() => {});
    rmSync(local, { recursive: true, force: true });
    s.close();
  }
});

test('editing safety: new files, change detection, and files that must not be edited as text', { skip }, async () => {
  const [host, port, username, privateKeyPath] = (target as string).split(':');
  const s = new Session();
  await s.connect({ host, port: Number(port), username, privateKeyPath }, async () => true);
  const root = `${await s.realpath('.')}/tavrix-edit-${process.pid}`;
  try {
    await s.mkdir(root);

    // new file: created empty with 0644, and never clobbers an existing one
    await s.createFile(`${root}/new.sh`);
    assert.deepEqual(await s.stat(`${root}/new.sh`), { size: 0, mtime: (await s.stat(`${root}/new.sh`))!.mtime, mode: 0o644 });
    await assert.rejects(s.createFile(`${root}/new.sh`));
    assert.equal(await s.stat(`${root}/missing`), null);

    // saving records a fresh stat; saving again from that stat succeeds
    const first = await s.saveFile(`${root}/new.sh`, '#!/bin/bash\necho 1\n', undefined, false);
    assert.equal(first.conflict, false);
    const expected = first.stat!;
    assert.equal(expected.size, 19);
    const second = await s.saveFile(`${root}/new.sh`, '#!/bin/bash\necho 2\n', expected, false);
    assert.equal(second.conflict, false);

    // someone else changes the file: our stale save is refused and nothing is overwritten
    await s.writeFile(`${root}/new.sh`, 'changed elsewhere, different length');
    const stale = await s.saveFile(`${root}/new.sh`, 'my stale edit', second.stat!, false);
    assert.equal(stale.conflict, true);
    assert.equal(await s.readFile(`${root}/new.sh`), 'changed elsewhere, different length');
    // ...unless forced
    assert.equal((await s.saveFile(`${root}/new.sh`, 'forced', second.stat!, true)).conflict, false);
    assert.equal(await s.readFile(`${root}/new.sh`), 'forced');

    // deleted on the server: reported as a conflict too, and force recreates it
    const before = (await s.stat(`${root}/new.sh`))!;
    await s.remove(`${root}/new.sh`);
    const gone = await s.saveFile(`${root}/new.sh`, 'x', before, false);
    assert.deepEqual([gone.conflict, gone.stat], [true, null]);

    // binary, non-UTF-8 and oversized files are refused instead of being corrupted on save
    writeFileSync(join(local0(), 'b.bin'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(local0(), 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    writeFileSync(join(local0(), 'big.txt'), 'a'.repeat(5 * 1024 * 1024 + 1));
    await s.upload([join(local0(), 'b.bin'), join(local0(), 'latin1.txt'), join(local0(), 'big.txt')], root, () => {}, async () => true);
    await assert.rejects(s.readFile(`${root}/b.bin`), /binary/);
    await assert.rejects(s.readFile(`${root}/latin1.txt`), /UTF-8/);
    await assert.rejects(s.readFile(`${root}/big.txt`), /too large/);
    await s.writeFile(`${root}/ok.txt`, 'héllo ✓');
    assert.equal(await s.readFile(`${root}/ok.txt`), 'héllo ✓');
    await assert.rejects(s.readFile(`${root}/nope`), /does not exist/);
  } finally {
    await s.remove(root).catch(() => {});
    rmSync(local0(), { recursive: true, force: true });
    s.close();
  }
});

let scratch: string | undefined;
function local0(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'tavrix-edit-'));
  return scratch;
}

test('fast paths return exactly the same data: parallel file reads and pipelined folder listings', { skip }, async () => {
  const [host, port, username, privateKeyPath] = (target as string).split(':');
  const s = new Session();
  await s.connect({ host, port: Number(port), username, privateKeyPath }, async () => true);
  const root = `${await s.realpath('.')}/tavrix-fast-${process.pid}`;
  try {
    await s.mkdir(root);

    // file sizes around the 32 KB read-piece boundary, with multi-byte characters straddling pieces
    for (const n of [0, 1, 32767, 32768, 32769, 65536, 100001]) {
      const text = 'aé✓'.repeat(Math.ceil(n / 6)).slice(0, n);
      await s.writeFile(`${root}/f${n}`, text);
      const r = await s.openText(`${root}/f${n}`);
      assert.equal(r.content, text, `size ${n}`);
      assert.equal(r.stat.size, Buffer.byteLength(text), `stat size ${n}`);
    }
    await assert.rejects(s.openText(`${root}/missing`), /does not exist/);
    await s.writeFile(`${root}/locked`, 'secret');
    await s.chmod(`${root}/locked`, 0o000);
    if (process.getuid?.() !== 0) await assert.rejects(s.openText(`${root}/locked`), /Permission denied|Failure/);
    await s.chmod(`${root}/locked`, 0o644);

    // a folder much bigger than one READDIR reply, compared with the library's own sequential reader
    await s.mkdir(`${root}/many`);
    const names = Array.from({ length: 1500 }, (_, i) => `file-${i}.txt`);
    for (let i = 0; i < names.length; i += 100) await Promise.all(names.slice(i, i + 100).map((n) => s.createFile(`${root}/many/${n}`)));
    await s.mkdir(`${root}/many/zz-sub`);
    const fast = (await s.list(`${root}/many`)).map((e) => e.name);
    const sftp = await (s as unknown as { sftp(): Promise<{ readdir(p: string, cb: (e: Error | undefined, l: { filename: string }[]) => void): void }> }).sftp();
    const slow = await new Promise<string[]>((res, rej) => sftp.readdir(`${root}/many`, (e, l) => (e ? rej(e) : res(l.map((x) => x.filename)))));
    assert.equal(fast.length, 1501);
    assert.deepEqual([...fast].sort(), [...slow].sort(), 'same names, none missing, none repeated');
    assert.equal(new Set(fast).size, fast.length);
    assert.equal(fast[0], 'zz-sub', 'folders sort first');
    assert.deepEqual(await s.list(`${root}/many/zz-sub`), [], 'an empty folder');
    await assert.rejects(s.list(`${root}/nope`));
  } finally {
    await s.remove(root).catch(() => {});
    s.close();
  }
});
