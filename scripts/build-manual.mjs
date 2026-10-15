// Turn docs/MANUAL.md into src/renderer/manual.html, the page shown by the in-app Manual window.
// The same markdown is what GitHub displays, so the two never drift apart.
import { readFileSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';

const source = readFileSync('docs/MANUAL.md', 'utf8');
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

const toc = [];
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      const id = slug(text);
      if (depth === 2) toc.push({ id, text });
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    // Images are written as images/x.png in the markdown (right for GitHub); the app page sits two levels deeper.
    image({ href, title, text }) {
      const src = href.startsWith('images/') ? `../../docs/${href}` : href;
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(text)}" loading="lazy">${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ''}</figure>`;
    },
    link({ href, title, tokens }) {
      const external = /^https?:/i.test(href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}${attrs}>${this.parser.parseInline(tokens)}</a>`;
    },
  },
});

const body = marked.parse(source, { async: false });
const nav = toc.map((t) => `<li><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join('\n');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tavrix manual</title>
<link rel="stylesheet" href="manual.css">
</head>
<body>
<nav aria-label="Contents"><strong>Contents</strong><ul>
${nav}
</ul></nav>
<main>
${body}
</main>
</body>
</html>
`;
writeFileSync('src/renderer/manual.html', html);
console.log(`manual.html: ${toc.length} sections, ${(html.length / 1024).toFixed(0)} KB`);
