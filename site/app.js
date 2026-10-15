// Fills in the download buttons from the project's latest GitHub release. Without JavaScript, or if GitHub cannot be
// reached, the buttons simply point at the releases page. Nothing here is sent anywhere except one anonymous GET to
// api.github.com for this repository's latest release.
(() => {
  'use strict';
  const REPO = 'farookhridoy/tavrix';
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const TRUSTED_DOWNLOAD = new RegExp(`^https://github\\.com/${REPO}/releases/download/[^/]+/[^/]+\\.dmg$`);
  const CACHE_KEY = 'tavrix-latest-release';
  const CACHE_MS = 10 * 60 * 1000; // be gentle with GitHub's anonymous rate limit
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  async function latestRelease() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.release;
    } catch { /* storage unavailable: just fetch */ }
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
    const release = await res.json();
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release })); } catch { /* ignore */ }
    return release;
  }

  const installerFor = (assets, arch) =>
    (Array.isArray(assets) ? assets : []).find((a) => typeof a?.name === 'string' && a.name.endsWith(`-${arch}.dmg`) && TRUSTED_DOWNLOAD.test(a.browser_download_url));

  const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;

  function render(release) {
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('unexpected version tag');
    const published = release.published_at ? new Date(release.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    for (const arch of ['arm64', 'x64']) {
      const asset = installerFor(release.assets, arch);
      if (!asset) continue;
      for (const a of $$(`a[data-download="${arch}"]`)) a.href = asset.browser_download_url;
      for (const el of $$(`[data-file="${arch}"]`)) el.textContent = asset.name;
      for (const el of $$(`[data-size="${arch}"]`)) el.textContent = `· ${megabytes(asset.size)}`;
      const sha = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
      if (/^[0-9a-f]{64}$/.test(sha)) for (const el of $$(`[data-sha="${arch}"]`)) el.textContent = `SHA-256 ${sha}`;
    }
    const line = $$('#dl-version')[0];
    if (line) {
      line.textContent = `Version ${version}${published ? ` · released ${published}` : ''} · `;
      const notes = document.createElement('a');
      notes.href = '/releases';
      notes.textContent = 'release notes';
      line.appendChild(notes);
    }
    const meta = $$('#hero-meta')[0];
    if (meta) meta.textContent = `Version ${version} · macOS, Apple Silicon and Intel · MIT license`;
  }

  /** Browsers hide the Mac's chip type, except Chromium which can say; use it only to highlight the likely choice. */
  async function likelyArch() {
    try {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
      return architecture === 'arm' ? 'arm64' : architecture === 'x86' ? 'x64' : null;
    } catch { return null; }
  }

  function markLikely(arch) {
    if (!arch) return;
    $$('.dl').forEach((card) => card.classList.toggle('recommended', card.dataset.arch === arch));
    const other = arch === 'arm64' ? 'x64' : 'arm64';
    for (const a of $$(`.cta a[data-download="${arch}"]`)) a.classList.add('primary');
    for (const a of $$(`.cta a[data-download="${other}"]`)) a.classList.remove('primary');
  }

  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (!/mac/i.test(platform) || /iphone|ipad/i.test(navigator.userAgent)) {
    const note = document.getElementById('not-mac');
    if (note) note.hidden = false;
  }

  latestRelease().then(render).catch(() => { /* the buttons keep pointing at the releases page */ });
  likelyArch().then(markLikely);
})();
