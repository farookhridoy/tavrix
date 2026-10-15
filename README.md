# Tavrix

An SSH workbench for macOS: terminal, remote file browser and editor in one window. v1.1.0.

## Run
```bash
npm install
npm start
```
Click + for a new connection (optionally through a jump host) (password, or private key path), or pick a saved session. Double-click folders to browse, double-click a file to edit it (Cmd+S saves), right-click for download/rename/permissions/delete, and drag files onto the file panel to upload.

## Also
- **Split** the terminal (status bar), **Tunnels** for -L/-R/-D forwarding, **Snippets** in the sidebar.
- Editor: Cmd+S saves; **Auto-save** is optional. If the file changed on the server meanwhile, Tavrix reloads a clean editor, warns a dirty one, and asks before overwriting. New files are created `644`; a script starting with `#!` gets a **Make executable** button (or use right-click > Permissions). Binary, non-UTF-8 and files over 5 MB are not opened as text.

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
