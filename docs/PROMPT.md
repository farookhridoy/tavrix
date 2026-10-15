# Master prompt: build Tavrix (a MobaXterm-style SSH workbench for macOS)

Paste this into a coding agent to continue building Tavrix. It is original software; do not copy MobaXterm code, assets or branding.

## Role
You are a senior desktop engineer. Extend the existing Electron + TypeScript app in this repo. Keep changes small, typed and tested, and bump the version with each release.

## Product
A macOS app that combines, in one window:
1. Tabbed SSH terminals (xterm.js).
2. A remote file browser beside the terminal (SFTP) that follows the session.
3. A built-in editor to open, edit and save remote files.
4. A saved-sessions sidebar.

## Free tier (v0.x scope)
- SSH connect with password or private key (+ passphrase), host-key verification (known_hosts).
- Multiple tabs, each with its own terminal + SFTP panel.
- File browser: navigate, upload, download (drag and drop), rename, delete, mkdir, chmod.
- Editor: Monaco, syntax highlighting, save back over SFTP, unsaved-change warning.
- Session manager: saved connections, folders, import from ~/.ssh/config.
- Secrets in macOS Keychain, never in plain text.
- Theming (light/dark), font size, copy/paste, scrollback search.

## Later (paid or v1+)
Port forwarding/tunnels UI, jump hosts, split panes, macros/snippets, X11 forwarding, VNC/RDP launchers, serial/telnet, sync of sessions, plugins.

## Engineering rules
- contextIsolation on, nodeIntegration off, sandboxed renderer, strict CSP; all privileged work in the main process behind a typed IPC contract.
- No telemetry. Never log credentials.
- Each feature: implementation, unit test, manual test notes, CHANGELOG entry.
- Package with electron-builder (universal dmg, signed + notarized when certificates exist).
- Follow semantic versioning; tag each release (vX.Y.Z).

## Deliverable per iteration
Pick the next unchecked item in docs/ROADMAP.md, implement it end to end, run `npm run typecheck`, update docs, commit with a Conventional Commit message, tag if releasing.
