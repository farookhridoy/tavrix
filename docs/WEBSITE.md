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

In hPanel open the website `tavrix.farookhridoy.com` → **Advanced → GIT** (the page that says "Deploy from Git repository"):

1. Click **Continue with GitHub** and sign in. When GitHub asks which repositories Hostinger may access, choose **Only select repositories → `farookhridoy/tavrix`**. Hostinger needs to read the repository, not write to it.
2. Select the repository **`farookhridoy/tavrix`** and the branch **`site`** (not `main`).
3. **Install path:** leave it as the website's root (`public_html`). If Hostinger says the folder is not empty, delete the default placeholder file (`default.php`) in **Files → File Manager** first, then deploy.
4. Turn on **auto-deployment** if it is offered (some plans show it as an *Auto deploy* switch or a webhook). Then every update of the `site` branch is deployed without any click.
5. Press **Deploy** and open https://tavrix.farookhridoy.com.

If your plan instead shows a plain repository-URL form: use `https://github.com/farookhridoy/tavrix.git`, branch `site`, and, for auto-deploy, add the webhook URL Hostinger shows under the repository's **Settings → Webhooks** (content type `application/json`, *Just the push event*).

The page itself is never cached (`Cache-Control: no-cache`), so a deploy shows up right away; CSS and JavaScript are cached for an hour, images for a day.

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
| `site` | Only the website workflow can update it, through a dedicated **deploy key** (stored as the `SITE_DEPLOY_KEY` secret; the built-in Actions token is not allowed to write there). Everyone else, including the owner, is blocked. Force-pushes and deletion are blocked. |

If you ever need to change this: GitHub → Settings → Rules → Rulesets. To rotate the publisher key: create a new key pair, replace the deploy key under Settings → Deploy keys (allow write access) and the `SITE_DEPLOY_KEY` secret under Settings → Secrets and variables → Actions, then delete the old key.

## Security notes

- The page sends no requests to other sites and runs one small script (highlights the likely Mac type). Its content-security policy (in `.htaccess`) forbids everything else.
- Hidden files, `.git` and the branch note are refused by `.htaccess`; directory listings are off.
- Release notes are untrusted text: they are escaped before they reach the page.
