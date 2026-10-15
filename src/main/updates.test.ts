import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isNewer, isTrustedUrl, checkForUpdate, openTarget, FetchLike, REPO } from './updates';

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.2.0',
  html_url: `https://github.com/${REPO}/releases/tag/v1.2.0`,
  body: 'Fixes things',
  assets: [
    { name: 'Tavrix-1.2.0-universal.dmg.blockmap', browser_download_url: `https://github.com/${REPO}/releases/download/v1.2.0/Tavrix-1.2.0-universal.dmg.blockmap` },
    { name: 'Tavrix-1.2.0-universal.dmg', browser_download_url: `https://github.com/${REPO}/releases/download/v1.2.0/Tavrix-1.2.0-universal.dmg` },
  ],
  ...over,
});
const reply = (status: number, body: unknown): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('versions compare numerically, not as text, and odd tags are rejected', () => {
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  for (const bad of ['nightly', '1.2', '1.2.3-beta', 'v1.2.3.4', '', ' ']) assert.equal(parseVersion(bad), null, bad);
  assert.ok(isNewer([1, 10, 0], [1, 9, 9]));
  assert.ok(isNewer([2, 0, 0], [1, 99, 99]));
  assert.ok(!isNewer([1, 2, 0], [1, 2, 0]));
  assert.ok(!isNewer([1, 1, 9], [1, 2, 0]));
});

test('only https links into this repository on github.com are trusted', () => {
  assert.ok(isTrustedUrl(`https://github.com/${REPO}/releases/tag/v1`));
  for (const bad of [
    'http://github.com/' + REPO + '/x',
    'https://evil.com/' + REPO + '/x',
    'https://github.com.evil.com/' + REPO + '/x',
    'https://github.com/someone-else/tavrix/releases',
    `https://github.com/${REPO}-fork/releases`,
    `https://user:pw@github.com/${REPO}/x`,
    'javascript:alert(1)', 'file:///etc/passwd', '', null, 42,
  ]) assert.equal(isTrustedUrl(bad), false, String(bad));
});

test('a newer release is reported with the universal installer chosen', async () => {
  const r = await checkForUpdate('1.1.0', reply(200, release()));
  assert.equal(r.kind, 'available');
  if (r.kind !== 'available') return;
  assert.equal(r.info.latest, '1.2.0');
  assert.ok(r.info.downloadUrl?.endsWith('Tavrix-1.2.0-universal.dmg'), 'not the .blockmap');
  assert.equal(r.info.notes, 'Fixes things');
});

test('up to date, newer-than-latest and no-releases are not updates', async () => {
  assert.deepEqual(await checkForUpdate('1.2.0', reply(200, release())), { kind: 'current', current: '1.2.0', latest: '1.2.0' });
  assert.equal((await checkForUpdate('2.0.0', reply(200, release()))).kind, 'current');
  assert.deepEqual(await checkForUpdate('1.0.0', reply(404, {})), { kind: 'none' });
});

test('bad or hostile feeds become errors, never an offer', async () => {
  const kinds = async (f: FetchLike) => (await checkForUpdate('1.1.0', f)).kind;
  assert.equal(await kinds(reply(500, {})), 'error');
  assert.equal(await kinds(reply(403, {})), 'error');
  assert.equal(await kinds(reply(200, release({ tag_name: 'nightly' }))), 'error');
  assert.equal(await kinds(reply(200, release({ tag_name: undefined }))), 'error');
  assert.equal(await kinds(reply(200, release({ html_url: 'https://evil.example/' + REPO + '/x' }))), 'error');
  assert.equal(await kinds(async () => { throw new Error('offline'); }), 'error');
  assert.equal(await kinds(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })), 'error');
  assert.equal((await checkForUpdate('dev', reply(200, release()))).kind, 'error');
  // an untrusted installer link is dropped, but the release page still works
  const r = await checkForUpdate('1.1.0', reply(200, release({ assets: [{ name: 'x.dmg', browser_download_url: 'https://evil.example/x.dmg' }] })));
  assert.ok(r.kind === 'available' && r.info.downloadUrl === undefined);
});

test('the banner buttons open only vetted URLs', async () => {
  const r = await checkForUpdate('1.1.0', reply(200, release()));
  assert.ok(r.kind === 'available');
  if (r.kind !== 'available') return;
  assert.ok(openTarget(r.info, 'download')?.endsWith('universal.dmg'));
  assert.ok(openTarget(r.info, 'notes')?.includes('/releases/tag/'));
  assert.equal(openTarget(null, 'download'), null);
  assert.equal(openTarget({ ...r.info, downloadUrl: undefined }, 'download'), r.info.releaseUrl, 'falls back to the release page');
  assert.equal(openTarget({ ...r.info, releaseUrl: 'https://evil.example/', downloadUrl: undefined }, 'download'), null);
});

test('checks time out instead of hanging', async () => {
  const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  const r = await checkForUpdate('1.1.0', hang, undefined, 150);
  assert.equal(r.kind, 'error');
  assert.ok(Date.now() - started < 2000);
});
