# Roadmap

## v0.1.0: foundation
- [x] Electron + TypeScript scaffold with secure defaults
- [x] SSH connect (password / private key)
- [x] Interactive terminal (xterm.js)
- [x] Remote file browser (SFTP list, navigate)
- [x] Basic text editor with save over SFTP

## v0.2.0: sessions and safety
- [x] Host-key verification (trust on first use, block on change)
- [x] Saved sessions, secrets encrypted via macOS Keychain (Electron safeStorage)
- [x] Import ~/.ssh/config
- [x] Multiple tabs, unsaved-change warning in the editor

## v0.3.0 (current): file manager
- [x] Upload/download of files and folders with progress; drag and drop upload
- [x] Rename, delete (recursive), mkdir, chmod
- [x] Monaco editor with syntax highlighting, Cmd+S to save
- [ ] Cancel a running transfer (deferred)
- [ ] Prompt for a password at connect time (deferred)

## v0.4.0: packaging
- [ ] electron-builder universal .dmg, signing and notarization
- [ ] Auto-update

## v1.0+: power features
- [ ] Port forwarding UI, jump hosts, split panes, snippets, plugins
