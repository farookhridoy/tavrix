# Tavrix

An SSH workbench for macOS: terminal, remote file browser and editor in one window. Early development (v0.4.0).

## Run
```bash
npm install
npm start
```
Click + for a new connection (password, or private key path), or pick a saved session. Double-click folders to browse, double-click a file to edit it (Cmd+S saves), right-click for download/rename/permissions/delete, and drag files onto the file panel to upload.

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
