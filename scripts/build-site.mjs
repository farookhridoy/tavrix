#!/usr/bin/env node
// Builds the deployable website (the contents of the `site` branch) from the template in site/ and a GitHub release.
//
//   node scripts/build-site.mjs --out dist-site [--site-url https://…] [--release-file release.json] [--wait] [--offline]
//
// The result is deterministic: the same release always produces the same files, so a re-run that changes nothing
// produces no commit. Everything taken from the release is validated and HTML-escaped; if anything looks wrong the build
// fails and the previous site stays up.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'farookhridoy/tavrix';
export const DEFAULT_SITE_URL = 'https://tavrix.farookhridoy.com';
const ARCHS = ['arm64', 'x64'];
const SKIP_FROM_SOURCE = new Set(['index.html', 'vercel.json']);

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The first bullets of the release notes, as plain text. Stops before the install table, checksums and warnings. */
export function extractHighlights(body, limit = 6) {
  const out = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*\|/.test(line) || /^SHA-256/i.test(line) || /^\*\*Not signed/i.test(line) || /^#{2,}\s*(install|checksum)/i.test(line)) break;
    const m = /^[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their text
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length >= 8) out.push(text.length > 170 ? text.slice(0, 167).trimEnd() + '…' : text);
    if (out.length === limit) break;
  }
  return out;
}

/** Turn a GitHub release into the facts the page needs, or throw if it is not a normal Tavrix release. */
export function parseRelease(release) {
  const fail = (why) => { throw new Error(`Release rejected: ${why}`); };
  if (!release || typeof release !== 'object') fail('no release data');
  if (release.draft || release.prerelease) fail('it is a draft or pre-release');
  const tag = String(release.tag_name || '');
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!m) fail(`unexpected tag "${tag}"`);
  const version = m[1];
  const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
  if (release.html_url !== releaseUrl) fail('its page is not in this repository');
  const published = new Date(release.published_at);
  if (Number.isNaN(published.getTime())) fail('no publish date');

  const list = Array.isArray(release.assets) ? release.assets : [];
  /** One installer asset, validated: exact name, exact download address, plausible size, well-formed checksum. */
  const installer = (name, label, { optional = false } = {}) => {
    const asset = list.find((a) => a && a.name === name);
    if (!asset) {
      if (optional) return null;
      fail(`the ${label} installer (${name}) is not attached`);
    }
    const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
    if (asset.browser_download_url !== url) fail(`the ${label} download address is not the expected one`);
    if (!Number.isInteger(asset.size) || asset.size < 5 * 1048576 || asset.size > 1024 * 1048576) fail(`the ${label} installer has an implausible size`);
    let sha256 = '';
    if (asset.digest !== undefined && asset.digest !== null) {
      const d = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest));
      if (!d) fail(`the ${label} checksum is malformed`);
      sha256 = d[1];
    }
    return { name, url, bytes: asset.size, sha256 };
  };
  const assets = {};
  for (const arch of ARCHS) assets[arch] = installer(`Tavrix-${version}-${arch}.dmg`, arch);
  // Windows is optional: a release made before the Windows build existed (or without it) simply shows no Windows download.
  assets.win = installer(`Tavrix-${version}-x64.exe`, 'Windows', { optional: true });
  return { version, tag, releaseUrl, publishedAt: published.toISOString(), assets, highlights: extractHighlights(release.body) };
}

/** What the page shows when there is no release to read (local previews only; CI never uses this). */
export function offlineFacts() {
  const releases = `https://github.com/${REPO}/releases/latest`;
  const asset = (arch) => ({ name: `Tavrix-latest-${arch}.dmg`, url: releases, bytes: 0, sha256: '' });
  return { version: 'latest', tag: 'latest', releaseUrl: releases, publishedAt: null, assets: { arm64: asset('arm64'), x64: asset('x64'), win: { name: 'Tavrix-latest-x64.exe', url: releases, bytes: 0, sha256: '' } }, highlights: [] };
}

const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'recently');
const megabytes = (bytes) => (bytes ? `${Math.round(bytes / 1048576)} MB` : '');

/** The value of every {{token}} the template may use. All are escaped for HTML. */
export function tokensFor(facts, siteUrl) {
  const t = {
    site_url: siteUrl,
    version: facts.version,
    released: longDate(facts.publishedAt),
    released_iso: facts.publishedAt ? facts.publishedAt.slice(0, 10) : '',
    notes_url: facts.releaseUrl,
    whatsnew: facts.highlights.length ? `<ul>${facts.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>` : '',
  };
  for (const arch of ARCHS) {
    const a = facts.assets[arch];
    t[`${arch}_url`] = a.url;
    t[`${arch}_name`] = a.name;
    t[`${arch}_size`] = megabytes(a.bytes);
    t[`${arch}_sha_line`] = a.sha256 ? `SHA-256 ${a.sha256}` : '';
  }
  const win = facts.assets.win;
  t.platforms = win ? 'Mac and Windows' : 'Mac';
  t.platforms_detail = win ? 'macOS (Apple Silicon and Intel) and Windows' : 'macOS, Apple Silicon and Intel';
  t.os_list = win ? 'macOS, Windows' : 'macOS';
  t.win_url = win ? win.url : facts.releaseUrl;
  t.win_name = win ? win.name : '';
  t.win_size = win ? megabytes(win.bytes) : '';
  t.win_sha_line = win && win.sha256 ? `SHA-256 ${win.sha256}` : '';
  const raw = new Set(['whatsnew']); // already built from escaped parts
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, raw.has(k) ? v : escapeHtml(v)]));
}

/** Fill the template. An unknown token is a bug in the template, so it fails instead of leaking "{{…}}" onto the site. */
export function fillTemplate(template, tokens, { hasNews, hasWindows = true }) {
  let html = template;
  if (!hasNews) html = html.replace(/<!--whatsnew-->[\s\S]*?<!--\/whatsnew-->/g, '');
  // Everything about the Windows download sits between <!--windows--> markers and disappears when the release has none.
  if (!hasWindows) html = html.replace(/<!--windows-->[\s\S]*?<!--\/windows-->/g, '');
  html = html.replace(/<!--\/?(whatsnew|windows)-->/g, '');
  return html.replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    if (!Object.hasOwn(tokens, name)) throw new Error(`Template uses an unknown token: {{${name}}}`);
    return tokens[name];
  });
}

export function buildSite({ sourceDir, outDir, facts, siteUrl = DEFAULT_SITE_URL }) {
  const template = readFileSync(join(sourceDir, 'index.html'), 'utf8');
  const tokens = tokensFor(facts, siteUrl);
  const html = fillTemplate(template, tokens, { hasNews: facts.highlights.length > 0, hasWindows: Boolean(facts.assets.win) });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(sourceDir, outDir, { recursive: true, filter: (src) => !SKIP_FROM_SOURCE.has(src.slice(sourceDir.length + 1)) });
  writeFileSync(join(outDir, 'index.html'), html);

  const entry = (a) => ({ name: a.name, url: a.url, bytes: a.bytes, sha256: a.sha256 });
  const downloads = Object.fromEntries(ARCHS.map((a) => [a, entry(facts.assets[a])]));
  if (facts.assets.win) downloads.windows = entry(facts.assets.win);
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify({ version: facts.version, tag: facts.tag, publishedAt: facts.publishedAt, releaseUrl: facts.releaseUrl, downloads }, null, 2) + '\n');
  writeFileSync(join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
  const lastmod = facts.publishedAt ? `<lastmod>${facts.publishedAt.slice(0, 10)}</lastmod>` : '';
  writeFileSync(join(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${escapeHtml(siteUrl)}/</loc>${lastmod}</url>\n</urlset>\n`);
  writeFileSync(
    join(outDir, 'README.md'),
    '# Tavrix website (generated)\n\nThis branch is generated by `.github/workflows/site.yml` from the `site/` folder on `main` and the latest GitHub release.\nDo not edit it by hand: change `site/` on `main` through a pull request, or publish a release.\n',
  );
  return { html, tokens };
}

// ---------- command line ----------
function ghReleaseJson() {
  return JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/releases/latest`], { encoding: 'utf8' }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function latestFacts({ wait }) {
  const deadline = Date.now() + (wait ? 10 * 60_000 : 0);
  for (;;) {
    try {
      return parseRelease(ghReleaseJson());
    } catch (err) {
      // A release is published a moment before its installers finish uploading; wait for them instead of failing.
      if (!wait || Date.now() > deadline || !/not attached/.test(err.message)) throw err;
      console.log(`${err.message}; waiting for the upload…`);
      await sleep(20_000);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = resolve(opt('--out') || join(root, 'dist-site'));
  const siteUrl = (opt('--site-url') || DEFAULT_SITE_URL).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(siteUrl)) throw new Error('--site-url must be an https address without a path');
  let facts;
  if (args.includes('--offline')) facts = offlineFacts();
  else if (opt('--release-file')) facts = parseRelease(JSON.parse(readFileSync(opt('--release-file'), 'utf8')));
  else facts = await latestFacts({ wait: args.includes('--wait') });
  buildSite({ sourceDir: join(root, 'site'), outDir, facts, siteUrl });
  console.log(`Built website for ${facts.tag} into ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
