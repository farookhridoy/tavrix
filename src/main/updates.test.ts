import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isNewer, isTrustedUrl, checkForUpdate as check, openTarget, FetchLike, REPO } from './updates';

/** These tests are about the Mac installer, so they pin the platform; the default is whatever computer runs the tests (CI runs them on Windows too). */
const checkForUpdate = (current: string, f: FetchLike, url?: string, timeoutMs = 8000, arch = 'arm64') => check(current, f, url, timeoutMs, arch, 'darwin');

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

test('the installer matching this Mac is chosen: arm64, x64, universal, then any dmg', async () => {
  // (macOS is the default platform in these tests; Windows is covered below.)
  const asset = (name: string) => ({ name, browser_download_url: `https://github.com/${REPO}/releases/download/v1.2.0/${name}` });
  const pick = async (names: string[], arch: string) => {
    const r = await checkForUpdate('1.1.0', reply(200, release({ assets: names.map(asset) })), undefined, 8000, arch);
    return r.kind === 'available' ? r.info.downloadUrl?.split('/').pop() : undefined;
  };
  const both = ['Tavrix-1.2.0-x64.dmg', 'Tavrix-1.2.0-arm64.dmg', 'Tavrix-1.2.0-arm64.dmg.blockmap'];
  assert.equal(await pick(both, 'arm64'), 'Tavrix-1.2.0-arm64.dmg');
  assert.equal(await pick(both, 'x64'), 'Tavrix-1.2.0-x64.dmg');
  assert.equal(await pick(['Tavrix-1.2.0-universal.dmg', 'Tavrix-1.2.0-x64.dmg'], 'arm64'), 'Tavrix-1.2.0-universal.dmg');
  assert.equal(await pick(['Tavrix-1.2.0-x64.dmg'], 'arm64'), 'Tavrix-1.2.0-x64.dmg', 'better something than nothing; the page explains');
  assert.equal(await pick(['notes.txt'], 'arm64'), undefined);
});

test('on Windows the .exe installer is chosen, never a .dmg or a blockmap', async () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://github.com/${REPO}/releases/download/v1.8.0/${name}` });
  const pick = async (names: string[], arch = 'x64') => {
    const r = await check('1.7.0', reply(200, release({ tag_name: 'v1.8.0', html_url: `https://github.com/${REPO}/releases/tag/v1.8.0`, assets: names.map(asset) })), undefined, 8000, arch, 'win32');
    return r.kind === 'available' ? r.info.downloadUrl?.split('/').pop() : undefined;
  };
  const all = ['Tavrix-1.8.0-arm64.dmg', 'Tavrix-1.8.0-x64.dmg', 'Tavrix-1.8.0-x64.exe', 'Tavrix-1.8.0-x64.exe.blockmap'];
  assert.equal(await pick(all), 'Tavrix-1.8.0-x64.exe');
  assert.equal(await pick(all, 'arm64'), 'Tavrix-1.8.0-x64.exe', 'Windows on ARM runs the x64 installer');
  assert.equal(await pick(['Tavrix-1.8.0-x64.dmg']), undefined, 'a release with only Mac installers offers no direct Windows download');
  assert.equal(await pickOnMac(all), 'Tavrix-1.8.0-x64.dmg', 'the Mac still gets its dmg from the same release');

  async function pickOnMac(names: string[]) {
    const r = await check('1.7.0', reply(200, release({ tag_name: 'v1.8.0', html_url: `https://github.com/${REPO}/releases/tag/v1.8.0`, assets: names.map(asset) })), undefined, 8000, 'x64', 'darwin');
    return r.kind === 'available' ? r.info.downloadUrl?.split('/').pop() : undefined;
  }
});
