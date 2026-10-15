import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRelease, extractHighlights, escapeHtml, fillTemplate, tokensFor, buildSite, offlineFacts, REPO } from './build-site.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA_A = 'a'.repeat(64);
const SHA_X = 'b'.repeat(64);

const BODY = `## Tavrix 1.7.0: tour, manual, tabs and a resizable layout

- **Quick tour** on first launch (8 short steps; close it any time).
- **Manual** button opens the [full documentation](https://example.com/x) inside the app.
- Short
- Fixes: the editor could only grow when dragging its divider.

| Mac | File |
|---|---|
| Apple Silicon | \`Tavrix-1.7.0-arm64.dmg\` (87 MB) |

**Not signed by an Apple developer:** macOS blocks a downloaded copy.

SHA-256
- arm64: \`${SHA_A}\`
- x64: \`${SHA_X}\`
`;

const release = (over = {}) => ({
  tag_name: 'v1.7.0', draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/v1.7.0`,
  published_at: '2026-10-15T08:30:00Z', body: BODY,
  assets: [
    { name: 'Tavrix-1.7.0-arm64.dmg', size: 91_000_000, digest: `sha256:${SHA_A}`, browser_download_url: `https://github.com/${REPO}/releases/download/v1.7.0/Tavrix-1.7.0-arm64.dmg` },
    { name: 'Tavrix-1.7.0-x64.dmg', size: 101_000_000, digest: `sha256:${SHA_X}`, browser_download_url: `https://github.com/${REPO}/releases/download/v1.7.0/Tavrix-1.7.0-x64.dmg` },
  ],
  ...over,
});
const rejected = (over, re) => assert.throws(() => parseRelease(release(over)), re);

test('a normal release is read correctly', () => {
  const f = parseRelease(release());
  assert.equal(f.version, '1.7.0');
  assert.equal(f.assets.arm64.sha256, SHA_A);
  assert.equal(f.assets.x64.bytes, 101_000_000);
  assert.equal(f.publishedAt, '2026-10-15T08:30:00.000Z');
});

test('the "what\'s new" list takes the opening bullets only: no table, checksums or warnings', () => {
  const h = extractHighlights(BODY);
  assert.deepEqual(h, [
    'Quick tour on first launch (8 short steps; close it any time).',
    'Manual button opens the full documentation inside the app.',
    'Fixes: the editor could only grow when dragging its divider.',
  ]);
  assert.ok(!h.some((x) => /SHA|arm64:|Not signed/i.test(x)));
  assert.deepEqual(extractHighlights(''), []);
  assert.deepEqual(extractHighlights(undefined), []);
  assert.equal(extractHighlights('- ' + 'x'.repeat(400))[0].length, 168);
});

test('releases that are not a plain Tavrix release are refused, so a bad one can never reach the site', () => {
  rejected({ draft: true }, /draft/);
  rejected({ prerelease: true }, /pre-release/);
  rejected({ tag_name: 'v1.7.0-beta' }, /unexpected tag/);
  rejected({ tag_name: 'nightly' }, /unexpected tag/);
  rejected({ html_url: 'https://evil.example/releases/tag/v1.7.0' }, /not in this repository/);
  rejected({ published_at: 'yesterday' }, /publish date/);
  rejected({ assets: release().assets.slice(0, 1) }, /x64 installer.*not attached/);
  rejected({ assets: [] }, /not attached/);
  const swap = (i, patch) => release().assets.map((a, n) => (n === i ? { ...a, ...patch } : a));
  rejected({ assets: swap(0, { browser_download_url: 'https://evil.example/Tavrix-1.7.0-arm64.dmg' }) }, /download address/);
  rejected({ assets: swap(0, { browser_download_url: `https://github.com/someone-else/tavrix/releases/download/v1.7.0/Tavrix-1.7.0-arm64.dmg` }) }, /download address/);
  rejected({ assets: swap(1, { size: 12 }) }, /implausible size/);
  rejected({ assets: swap(1, { size: 5_000_000_000 }) }, /implausible size/);
  rejected({ assets: swap(0, { digest: 'sha256:xyz' }) }, /checksum is malformed/);
  rejected({ assets: swap(0, { digest: `md5:${'a'.repeat(32)}` }) }, /checksum is malformed/);
  assert.throws(() => parseRelease(null), /no release data/);
});

test('a release without checksums is accepted (older API responses); the page simply omits the line', () => {
  const noDigest = release().assets.map((a) => ({ ...a, digest: null }));
  const f = parseRelease(release({ assets: noDigest }));
  assert.equal(f.assets.arm64.sha256, '');
  assert.equal(tokensFor(f, 'https://x.example').arm64_sha_line, '');
});

test('text from the release is escaped, so release notes cannot inject markup into the page', () => {
  assert.equal(escapeHtml(`<script>alert("x")</script> & 'y'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  const f = parseRelease(release({ body: `- Hello <img src=x onerror=alert(1)> and "quotes" & more\n- <script>steal()</script> second bullet here` }));
  const { whatsnew } = tokensFor(f, 'https://x.example');
  assert.ok(!/<img|<script/i.test(whatsnew), whatsnew);
  assert.match(whatsnew, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(whatsnew, /^<ul><li>.*<\/li><li>.*<\/li><\/ul>$/);
});

test('the template is filled completely, and an unknown token fails loudly', () => {
  const tokens = tokensFor(parseRelease(release()), 'https://tavrix.example');
  assert.equal(fillTemplate('v{{version}} on {{released}} ({{released_iso}})', tokens, { hasNews: true }), 'v1.7.0 on October 15, 2026 (2026-10-15)');
  assert.throws(() => fillTemplate('{{version}} {{nope}}', tokens, { hasNews: true }), /unknown token: \{\{nope\}\}/);
  assert.equal(fillTemplate('a<!--whatsnew-->NEWS<!--/whatsnew-->b', tokens, { hasNews: false }), 'ab');
  assert.equal(fillTemplate('a<!--whatsnew-->NEWS<!--/whatsnew-->b', tokens, { hasNews: true }), 'aNEWSb');
  assert.equal(tokensFor(parseRelease(release()), 'https://tavrix.example').arm64_size, '87 MB');
});

test('a full build produces a complete, clean, deterministic site', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavrix-site-'));
  try {
    const facts = parseRelease(release());
    const a = join(dir, 'a'); const b = join(dir, 'b');
    buildSite({ sourceDir: join(root, 'site'), outDir: a, facts, siteUrl: 'https://tavrix.example' });
    buildSite({ sourceDir: join(root, 'site'), outDir: b, facts, siteUrl: 'https://tavrix.example' });

    const files = readdirSync(a).sort();
    for (const f of ['.htaccess', '404.html', 'README.md', 'app.js', 'favicon.png', 'img', 'index.html', 'latest.json', 'og.png', 'robots.txt', 'sitemap.xml', 'styles.css']) assert.ok(files.includes(f), `${f} is in the build`);
    assert.ok(!files.includes('vercel.json'));

    const html = readFileSync(join(a, 'index.html'), 'utf8');
    assert.ok(!/\{\{|\}\}|<!--\/?whatsnew-->/.test(html), 'no leftover template markers');
    assert.match(html, /Version 1\.7\.0 · released October 15, 2026/);
    assert.match(html, new RegExp(`href="https://github\\.com/${REPO}/releases/download/v1\\.7\\.0/Tavrix-1\\.7\\.0-arm64\\.dmg"`));
    assert.match(html, new RegExp(`SHA-256 ${SHA_A}`));
    assert.match(html, /What's new in 1\.7\.0/);
    assert.match(html, /<link rel="canonical" href="https:\/\/tavrix\.example\/">/);
    assert.match(html, /"softwareVersion": "1\.7\.0"/);
    assert.ok(!/__SITE_URL__/.test(html));

    const latest = JSON.parse(readFileSync(join(a, 'latest.json'), 'utf8'));
    assert.equal(latest.version, '1.7.0');
    assert.equal(latest.downloads.arm64.sha256, SHA_A);
    assert.match(readFileSync(join(a, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/tavrix\.example\/<\/loc><lastmod>2026-10-15<\/lastmod>/);
    assert.match(readFileSync(join(a, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/tavrix\.example\/sitemap\.xml/);

    for (const f of ['index.html', 'latest.json', 'sitemap.xml', 'robots.txt', '.htaccess', 'README.md']) {
      assert.equal(readFileSync(join(a, f), 'utf8'), readFileSync(join(b, f), 'utf8'), `${f} is identical across builds, so re-running never creates a pointless commit`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without highlights the "what\'s new" block disappears entirely; offline previews still build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tavrix-site-'));
  try {
    buildSite({ sourceDir: join(root, 'site'), outDir: dir, facts: parseRelease(release({ body: '' })) });
    assert.ok(!/What's new/.test(readFileSync(join(dir, 'index.html'), 'utf8')));
    buildSite({ sourceDir: join(root, 'site'), outDir: dir, facts: offlineFacts() });
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(html, /Version latest/);
    assert.ok(!/\{\{/.test(html));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the server config blocks hidden files, sets security headers, and its short links point only at this project', () => {
  const ht = readFileSync(join(root, 'site', '.htaccess'), 'utf8');
  assert.match(ht, /Options -Indexes/);
  assert.match(ht, /frame-ancestors 'none'/);
  assert.match(ht, /default-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(ht));
  for (const target of ht.match(/https:\/\/[^\s\]]+/g).filter((u) => !u.includes('schemas'))) assert.ok(target.startsWith(`https://github.com/${REPO}`), target);
  assert.ok(existsSync(join(root, 'site', '404.html')));
});
