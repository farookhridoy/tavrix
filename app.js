// Small touches only; the page is complete without this script. Nothing here makes a network request.
(() => {
  'use strict';
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /** Browsers hide the Mac's chip type, except Chromium, which can say. Used only to highlight the likely choice. */
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
    $$(`.cta a[data-download="${arch}"]`).forEach((a) => a.classList.add('primary'));
    $$(`.cta a[data-download="${other}"]`).forEach((a) => a.classList.remove('primary'));
  }

  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (!/mac/i.test(platform) || /iphone|ipad/i.test(navigator.userAgent)) {
    const note = document.getElementById('not-mac');
    if (note) note.hidden = false;
  }
  likelyArch().then(markLikely);
})();
