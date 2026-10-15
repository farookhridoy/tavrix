# Changelog

## 0.2.0
- Host-key verification: prompt on first connect, block if the key changes (own `known_hosts.json` in the app data folder).
- Saved sessions sidebar; passwords/passphrases encrypted with macOS Keychain via Electron safeStorage.
- Import hosts from `~/.ssh/config`.
- Multiple tabs, each with its own terminal, file browser and editor.
- Editor warns before discarding unsaved changes.
- Tests for SSH config parsing and host-key verification (`npm test`).

## 0.1.0
- Initial scaffold: SSH terminal, SFTP file browser, basic remote editor.
