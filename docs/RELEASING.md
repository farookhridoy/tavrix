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

## Signed and notarized (needs an Apple Developer account, not yet tested)
1. Create a "Developer ID Application" certificate and export it as a `.p12`.
2. Create an app-specific password for your Apple ID.
3. Set these, then build:
```bash
export CSC_LINK=/path/to/developer-id.p12     # or base64 of it
export CSC_KEY_PASSWORD=...
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=XXXXXXXXXX
npm run dist:release
```
Hardened runtime and entitlements are already configured (`build/entitlements.mac.plist`). Verify with `spctl -a -vv release/mac-universal/Tavrix.app` and `xcrun stapler validate`.

## Cutting a version
1. Update `CHANGELOG.md` and `docs/ROADMAP.md`.
2. `npm version <x.y.z> --no-git-tag-version`, run `npm test`.
3. Commit, `git tag vX.Y.Z`, `git push origin main vX.Y.Z`.
4. Build the installer and attach it to a GitHub release if you want to distribute it (the `.dmg` is about 230 MB).

## Notes
- ssh2's optional native crypto addon and `cpu-features` are excluded from the bundle; ssh2 uses its JavaScript fallback. This is required for a universal build because both architectures would contain the same binary.
- Auto-update is not enabled. macOS auto-update needs a signed app and a reachable release feed; this repo is private.
