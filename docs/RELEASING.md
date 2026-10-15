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

## Publishing a release (this is what triggers the update notice)
Installed apps learn about a new version from the **latest GitHub Release**, not from a push. After tagging:
```bash
npm run dist                                   # release/Tavrix-<version>-arm64.dmg and -x64.dmg
shasum -a 256 release/Tavrix-<version>-*.dmg
gh release create vX.Y.Z release/Tavrix-X.Y.Z-arm64.dmg release/Tavrix-X.Y.Z-x64.dmg --title "Tavrix X.Y.Z" --notes-file notes.md
```
Name the files so the CPU is the last part before `.dmg` (`-arm64.dmg`, `-x64.dmg`); the update notice uses that to pick the right one. Put the changelog entry, both SHA-256 values and the "unsigned: right-click > Open" note in the release notes. The tag must be plain `vX.Y.Z` (no `-beta`); other tags are ignored by the app. Mark pre-releases as pre-release so they are not "latest".

## Cutting a version
1. Update `CHANGELOG.md` and `docs/ROADMAP.md`.
2. `npm version <x.y.z> --no-git-tag-version`, run `npm test`.
3. Commit, `git tag vX.Y.Z`, `git push origin main vX.Y.Z`.
4. Build the installer and attach it to a GitHub release if you want to distribute it (the `.dmg` is about 230 MB).

## Notes
- ssh2's optional native crypto addon and `cpu-features` are excluded from the bundle; ssh2 uses its JavaScript fallback (speed on a fast local link drops, connection time is unchanged).
- Size: the browser engine (Electron) is ~250 MB of the installed app per CPU; Tavrix itself is ~14 MB. Going much lower would mean replacing Electron (e.g. Tauri), which is a rewrite.
- Silent auto-install is not possible while the app is unsigned (macOS requires a signature). Tavrix instead notifies and opens the download.
