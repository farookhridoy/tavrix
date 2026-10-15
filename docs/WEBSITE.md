# The website

**https://tavrix.farookhridoy.com**, hosted on Hostinger. It is a small static site (no framework, no trackers, no requests to other sites). It always shows the latest release: version, download links, file sizes, SHA-256 checksums and a "What's new" list taken from the release notes.

## How it stays up to date

```
site/ on main (the template)  ┐
                              ├─ .github/workflows/site.yml ──► `site` branch ──► Hostinger (Git deploy)
latest GitHub release         ┘      scripts/build-site.mjs        (generated)         public_html
```

- **`site/` on `main`** is the source: `index.html` (a template with `{{tokens}}`), `styles.css`, `app.js`, images and `.htaccess`.
- **`scripts/build-site.mjs`** fills the template from the latest release. It checks everything it reads (tag format, that links point at this repository's release downloads, sizes, checksums), escapes all text, and **fails instead of publishing** if anything looks wrong, so the previous site stays up. The output is deterministic, so running it twice never creates a pointless commit.
- **`.github/workflows/site.yml`** runs the build and commits the result to the **`site` branch** when a release is published or edited, when `site/` changes on `main`, or when started by hand (Actions → Website → Run workflow).
- **The `site` branch** contains only the finished files. Never edit it by hand.
- **Hostinger** pulls the `site` branch whenever it changes.

## One-time Hostinger setup

In hPanel, open the website `tavrix.farookhridoy.com` → **Advanced → Git** (the labels may differ slightly between plans):

1. **Repository:** `https://github.com/farookhridoy/tavrix.git` (the repository is public, so no key is needed).
2. **Branch:** `site`.
3. **Install path:** leave it empty to deploy into the subdomain's `public_html`. If Hostinger says the folder is not empty, delete the default placeholder file (`default.php`) in the File Manager first, then deploy.
4. Press **Deploy**. The site appears at the address above.
5. For **auto-deploy**, copy the webhook URL Hostinger shows, then in GitHub open the repository → **Settings → Webhooks → Add webhook**: paste the URL as the *Payload URL*, content type `application/json`, and choose *Just the push event*. From then on every update of the `site` branch is deployed within seconds.

The first request after a deploy should show the new version; the page itself is never cached (`Cache-Control: no-cache`), and CSS/JS are cached for an hour.

## Changing the website

1. Edit files in `site/` on a branch, open a pull request, and merge it once CI passes.
2. The workflow rebuilds and updates the `site` branch; Hostinger deploys it.
3. To preview locally: `node scripts/build-site.mjs --out dist-site`, then serve `dist-site/` with any static server. Add `--offline` to build without reading a release.

Tests for the build live in `scripts/build-site.test.mjs` (`npm run test:site`) and run in CI.

## Protection

`main` and `site` are protected by GitHub rulesets so that nobody can change them directly, which matters because the project is open source:

| Branch | Rules |
|---|---|
| `main` | A pull request is required (including for the owner), the **test** check must pass, force-pushes and deletion are blocked. |
| `site` | Only the website workflow can update it; everything else, including the owner, is blocked. Force-pushes and deletion are blocked. |

If you ever need to change this: GitHub → Settings → Rules → Rulesets.

## Security notes

- The page sends no requests to other sites and runs one small script (highlights the likely Mac type). Its content-security policy (in `.htaccess`) forbids everything else.
- Hidden files, `.git` and the branch note are refused by `.htaccess`; directory listings are off.
- Release notes are untrusted text: they are escaped before they reach the page.
