# Tavrix

An SSH workbench for macOS: terminal, remote file browser and editor in one window. v1.2.0.

## Run
```bash
npm install
npm start
```
Click + for a new connection (optionally through a jump host) (password, or private key path), or pick a saved session. Double-click folders to browse, double-click a file to edit it (Cmd+S saves), right-click for download/rename/permissions/delete, and drag files onto the file panel to upload.

## Also
- **Split** the terminal (status bar), **Tunnels** for -L/-R/-D forwarding, **Snippets** in the sidebar.
- Editor: Cmd+S saves; **Auto-save** is optional. If the file changed on the server meanwhile, Tavrix reloads a clean editor, warns a dirty one, and asks before overwriting. New files are created `644`; a script starting with `#!` gets a **Make executable** button (or use right-click > Permissions). Binary, non-UTF-8 and files over 5 MB are not opened as text.

## Updates
Tavrix tells you when a newer version is published: a bar appears with **Download**, **Release notes**, **Later** and **Skip this version**. It only opens the download page in your browser; it never installs anything itself. Use the **Tavrix menu > Check for Updates…** at any time, or untick **Check for Updates Automatically** to stop the background check.

**Privacy:** the only network request Tavrix makes on its own is that check: an anonymous `GET https://api.github.com/repos/farookhridoy/tavrix/releases/latest` (it sends the app version in the User-Agent, and GitHub sees your IP address). Everything else goes only to the servers you connect to.

**Installing:** download the `.dmg` from [Releases](https://github.com/farookhridoy/tavrix/releases/latest), drag Tavrix to Applications. The app is not signed or notarized, so on first launch macOS blocks it: right-click Tavrix > **Open** > **Open**, or run `xattr -dr com.apple.quarantine /Applications/Tavrix.app`. Verify the download against the SHA-256 in the release notes (`shasum -a 256 file.dmg`).

## Build an installer
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist   # release/Tavrix-<version>-universal.dmg
```
See [Releasing](docs/RELEASING.md) for signing and notarization.

## Docs
- [Roadmap](docs/ROADMAP.md)
- [Releasing](docs/RELEASING.md)
- [Build prompt for coding agents](docs/PROMPT.md)

## Versioning
Semantic versioning; every release is tagged `vX.Y.Z` and listed in CHANGELOG.md.

License: MIT
