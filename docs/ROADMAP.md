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

## v0.3.0: file manager
- [x] Upload/download of files and folders with progress; drag and drop upload
- [x] Rename, delete (recursive), mkdir, chmod
- [x] Monaco editor with syntax highlighting, Cmd+S to save
- [ ] Cancel a running transfer (deferred)
- [ ] Prompt for a password at connect time (deferred)

## v0.4.0: packaging
- [x] electron-builder universal .dmg (Apple Silicon + Intel), app icon
- [x] Hardened runtime, entitlements and notarization config (needs Apple Developer credentials; untested)
- [ ] Auto-update (deferred: needs signed app and a reachable release feed)

## v0.5.0 (current): rough edges
- [x] Password / key-passphrase prompt at connect time (retry on wrong, never stored)
- [x] Cancel a running upload/download (partial file removed)
- [x] `~/.ssh/config` hosts without `User` default to your local account name
- [ ] Signed + notarized release build (needs the Developer ID certificate on the build Mac)

## v1.0+: power features
- [ ] Port forwarding UI, jump hosts, split panes, snippets, plugins
