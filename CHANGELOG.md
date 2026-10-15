# Changelog

## 0.3.0
- File manager: upload/download files and folders with progress, drag and drop upload, new folder, rename, chmod, recursive delete (confirmation required; symlinks are removed, never followed; deleting `/` is refused).
- Overwrite prompts for existing destinations; symlinks are skipped in transfers.
- Right-click menu and toolbar in the file panel; double-click to open.
- Monaco editor (replaces the textarea): syntax highlighting by file extension, Cmd+S saves.
- Integration test against a real SSH server: `TAVRIX_TEST_SSH=host:port:user:keyPath npm test`.

## 0.2.0
- Host-key verification: prompt on first connect, block if the key changes (own `known_hosts.json` in the app data folder).
- Saved sessions sidebar; passwords/passphrases encrypted with macOS Keychain via Electron safeStorage.
- Import hosts from `~/.ssh/config`.
- Multiple tabs, each with its own terminal, file browser and editor.
- Editor warns before discarding unsaved changes.
- Tests for SSH config parsing and host-key verification (`npm test`).

## 0.1.0
- Initial scaffold: SSH terminal, SFTP file browser, basic remote editor.
