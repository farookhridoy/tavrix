# Releasing Tavrix

## Build an installer (unsigned, works today)
```bash
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```
Output: `release/Tavrix-<version>-arm64.dmg` (Apple Silicon) and `-x64.dmg` (Intel), about 90 MB each. A final step (`scripts/shrink-dmg.mjs`) re-compresses them with LZMA. `npm run dist:dir` builds only an unpacked `.app` for your own CPU, which is faster for testing.

An unsigned app is ad-hoc signed (`-c.mac.identity=-`, without hardened runtime, which would block loading Electron's own libraries). This re-signing step is required: trimming Electron's languages after packaging otherwise leaves a broken seal and macOS can report the downloaded app as damaged. Check with `codesign --verify --deep --strict release/mac-arm64/Tavrix.app`. Built and run on the same Mac it opens normally. If you download it from elsewhere, macOS Gatekeeper blocks it (the popup offers only Done and Move to Trash). Click Done, then System Settings > Privacy & Security > Open Anyway (right-click > Open only works on older macOS), or:
```bash
xattr -dr com.apple.quarantine /Applications/Tavrix.app
```

## The Windows installer (built on GitHub, unsigned)
Windows installers are built on a real Windows machine by `.github/workflows/windows.yml`; building one on a Mac would need Wine and could not be tested. The workflow runs on every pull request that touches the app (so Windows breakage shows up before merging): it runs `npm test` on Windows, builds `release/Tavrix-<version>-x64.exe` with `electron-builder --win`, **starts the packaged app** with `Tavrix.exe --smoke-test` and checks that the window, the bridge, the terminal and the saved-session store came up with the Windows layout and shortcut labels, and uploads the installer as the `tavrix-windows` artifact (14 days).

To put the installer on a release (after the release exists, see below):
```bash
gh workflow run windows.yml -f tag=vX.Y.Z      # builds, tests, and attaches Tavrix-X.Y.Z-x64.exe and its .sha256
gh run watch                                  # wait for it to finish
```
The `attach` job refuses anything but a plain `vX.Y.Z` tag and needs the release to exist. When it has attached the installer the workflow also starts the **Website** workflow, so the page gets its Windows download a couple of minutes later (Hostinger deploys the `site` branch by itself). The installer is not signed, so Windows SmartScreen shows "Windows protected your PC" on first launch (More info, then Run anyway); a code-signing certificate would remove that.

Test locally on Windows with `npm ci && npm run dist:win`. On a Mac, `npm run build && npx electron-builder --win --dir -c.win.signAndEditExecutable=false` checks that the packaging configuration is valid (it cannot run the result).

## Signed and notarized (Apple Developer account)
One-time setup:
1. Get a **Developer ID Application** certificate into your login keychain: Xcode > Settings > Accounts > select your team > Manage Certificates > + > Developer ID Application (or create it at developer.apple.com > Certificates; needs the Account Holder or Admin role). Check it with:
   ```bash
   security find-identity -v -p codesigning     # should list "Developer ID Application: Your Name (TEAMID)"
   ```
2. Create an app-specific password at appleid.apple.com > Sign-In and Security > App-Specific Passwords.
3. Store notarization credentials in the keychain once (prompts for the password, so it never lands in shell history or a file):
   ```bash
   xcrun notarytool store-credentials "tavrix-notary" --apple-id you@example.com --team-id TEAMID
   ```

Each release:
```bash
APPLE_KEYCHAIN_PROFILE=tavrix-notary npm run dist:release
```
electron-builder finds the certificate in your keychain automatically, signs with the hardened runtime (`build/entitlements.mac.plist`), submits to Apple for notarization, and staples the ticket. Notarization usually takes a few minutes. Verify:
```bash
spctl -a -vv release/mac-arm64/Tavrix.app          # source=Notarized Developer ID
xcrun stapler validate release/Tavrix-<version>-arm64.dmg
```
Status: configured but not yet run end to end, because no certificate was available when this was written.
For CI, use `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` instead of the keychain.

## Publishing a release (this is what triggers the update notice and the website)
Installed apps learn about a new version from the **latest GitHub Release**, not from a push, and the website is rebuilt from it automatically (see [WEBSITE.md](WEBSITE.md)). After the version pull request is merged and tagged (below):
```bash
npm run dist                                   # release/Tavrix-<version>-arm64.dmg and -x64.dmg
shasum -a 256 release/Tavrix-<version>-*.dmg
# Create it as a DRAFT, upload, then publish: the website update starts when the release is published, so the installers
# must already be attached.
gh release create vX.Y.Z release/Tavrix-X.Y.Z-arm64.dmg release/Tavrix-X.Y.Z-x64.dmg --draft --title "Tavrix X.Y.Z" --notes-file notes.md
gh release edit vX.Y.Z --draft=false --latest
```
Name the files so the CPU is the last part before `.dmg` (`-arm64.dmg`, `-x64.dmg`); the update notice and the website use that. Put the changelog entry, both SHA-256 values and the first-launch ("Open Anyway") note in the release notes. **Write the highlights as the first bullets** (`- …`), before any table: the website shows up to six of them as "What's new". The tag must be plain `vX.Y.Z` (no `-beta`); the app and the website ignore other tags and pre-releases.

## Documentation and screenshots
`docs/MANUAL.md` is the single source for the manual. `npm run build` turns it into `src/renderer/manual.html` (git-ignored) for the in-app Manual window, and GitHub shows the same file. Screenshots live in `docs/images/` and are packaged with the app (about 1.7 MB). When the interface changes, retake the affected screenshots (they are plain PNG/JPEG files; the demo used for them is a scratch server with made-up sessions) and keep the file names the manual refers to.

## Cutting a version (main is protected)
Nobody, including the owner, pushes to `main` or `site` directly; changes go through a pull request that must pass CI.
1. `git switch -c release/X.Y.Z`, update `CHANGELOG.md` and `docs/ROADMAP.md`, then `npm version X.Y.Z --no-git-tag-version`.
2. `npm test` locally, commit, `git push -u origin release/X.Y.Z`, and open a pull request (`gh pr create`).
3. When the **test** check is green, merge it (`gh pr merge --squash`). Tags are not restricted, so tag the merge commit: `git switch main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Build and publish the Mac release as above, then add the Windows installer with the workflow command in the Windows section. The website updates itself when the release is published, and again, started by the Windows workflow, once the installer is attached.

## Notes
- ssh2's optional native crypto addon and `cpu-features` are excluded from the bundle; ssh2 uses its JavaScript fallback (speed on a fast local link drops, connection time is unchanged).
- Size: the browser engine (Electron) is ~250 MB of the installed app per CPU; Tavrix itself is ~14 MB. Going much lower would mean replacing Electron (e.g. Tauri), which is a rewrite.
- Silent auto-install is not possible while the app is unsigned (macOS requires a signature). Tavrix instead notifies and opens the download.
