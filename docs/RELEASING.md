# Releasing Tavrix

## Build an installer (unsigned, works today)
```bash
npm ci
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```
Output: `release/Tavrix-<version>-universal.dmg` (Apple Silicon + Intel). `npm run dist:dir` builds only an unpacked `.app` for your own CPU, which is faster for testing.

An unsigned app is ad-hoc signed only. Built and run on the same Mac it opens normally. If you download it from elsewhere, macOS Gatekeeper blocks it; allow it with right-click > Open, or:
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
spctl -a -vv release/mac-universal/Tavrix.app          # source=Notarized Developer ID
xcrun stapler validate release/Tavrix-<version>-universal.dmg
```
Status: configured but not yet run end to end, because no certificate was available when this was written.
For CI, use `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` instead of the keychain.

## Cutting a version
1. Update `CHANGELOG.md` and `docs/ROADMAP.md`.
2. `npm version <x.y.z> --no-git-tag-version`, run `npm test`.
3. Commit, `git tag vX.Y.Z`, `git push origin main vX.Y.Z`.
4. Build the installer and attach it to a GitHub release if you want to distribute it (the `.dmg` is about 230 MB).

## Notes
- ssh2's optional native crypto addon and `cpu-features` are excluded from the bundle; ssh2 uses its JavaScript fallback. This is required for a universal build because both architectures would contain the same binary.
- Auto-update is not enabled. macOS auto-update needs a signed app and a reachable release feed; this repo is private.
