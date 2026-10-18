// Small touches only; the page is complete without this script. Nothing here makes a network request.
(() => {
  'use strict';
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /** Which computer is this? Only used to highlight the likely download and to show the matching install steps. */
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const isMobile = /iphone|ipad|android/i.test(navigator.userAgent);
  const os = isMobile ? null : /win/i.test(platform) ? 'win' : /mac/i.test(platform) ? 'mac' : null;

  /** Browsers hide the Mac's chip type, except Chromium, which can say. Used only to highlight the likely choice. */
  async function likelyArch() {
    try {
      const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
      return architecture === 'arm' ? 'arm64' : architecture === 'x86' ? 'x64' : null;
    } catch { return null; }
  }

  /** Highlight one download ("arm64" | "x64" | "win"): its card, its card button and its hero button. */
  function markLikely(key) {
    if (!key) return;
    $$('.dl').forEach((card) => card.classList.toggle('recommended', card.dataset.arch === key));
    $$('.cta a[data-download], .dl a[data-download]').forEach((a) => a.classList.toggle('primary', a.dataset.download === key));
  }

  /** Show the first-launch notes for one computer (or both when we cannot tell). */
  function showOs(which) {
    $$('.os-steps, .first-open[data-os], .hint[data-os]').forEach((n) => { n.hidden = Boolean(which) && n.dataset.os !== which; });
    $$('#os-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.os === which)));
  }

  const tabs = document.getElementById('os-tabs');
  if (tabs) {
    tabs.hidden = false; // the switch only makes sense when the script can drive it
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-os]');
      if (b) showOs(b.dataset.os);
    });
  }

  if (os === 'win') {
    markLikely('win');
    showOs('win');
  } else if (os === 'mac') {
    likelyArch().then(markLikely);
    showOs('mac');
  } else {
    const note = document.getElementById('not-mac');
    if (note) note.hidden = false;
    showOs(tabs ? 'mac' : null);
  }
})();
