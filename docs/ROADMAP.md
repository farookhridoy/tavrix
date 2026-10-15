# Roadmap

## v0.1.0: foundation
- [x] Electron + TypeScript scaffold with secure defaults
- [x] SSH connect (password / private key)
- [x] Interactive terminal (xterm.js)
- [x] Remote file browser (SFTP list, navigate)
- [x] Basic text editor with save over SFTP

## v0.2.0 (current): sessions and safety
- [x] Host-key verification (trust on first use, block on change)
- [x] Saved sessions, secrets encrypted via macOS Keychain (Electron safeStorage)
- [x] Import ~/.ssh/config
- [x] Multiple tabs, unsaved-change warning in the editor

## v0.3.0: file manager
- [ ] Upload/download with progress, drag and drop
- [ ] Rename, delete, mkdir, chmod
- [ ] Monaco editor

## v0.4.0: packaging
- [ ] electron-builder universal .dmg, signing and notarization
- [ ] Auto-update

## v1.0+: power features
- [ ] Port forwarding UI, jump hosts, split panes, snippets, plugins
