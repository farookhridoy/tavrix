# Changelog

## 1.5.0
- **Browse… button for the private key** in the session dialog: pick the key file instead of typing its path. The file window opens in `~/.ssh` with hidden files shown.
- The chosen file is checked and described right below the field: a private key, an encrypted private key (you will be asked for its passphrase), a public `.pub` file (flagged: choose the private one), or not a key. Key contents are never sent to the window.
- Fix: a key path typed as `~/.ssh/id_ed25519` now works (the `~` shorthand used to fail with "file not found").

## 1.4.2
- A visible **⚙ Settings** button in the sidebar header (next to + and Import). Settings was only reachable from the menu bar (Tavrix > Settings…, Cmd+,), which was hard to find. The menu item and shortcut still work and are now covered by a test that drives the real menu.

## 1.4.1
- Fix: the app's code signature was inconsistent (macOS reported "code has no resources but signature indicates they must be present"), a side effect of trimming languages after Electron sealed the app (since 1.2.1). On the Mac that built it the app still opened, but a downloaded copy could be shown as "damaged" instead of the usual "unidentified developer". Unsigned builds are now ad-hoc signed after packaging, so the signature verifies (`codesign --verify --deep --strict`) and macOS gives the normal prompt that right-click > Open can approve.
- Builds that use a real Developer ID are unchanged (hardened runtime stays on for notarization).
- Releases 1.2.1 to 1.4.0 have the old signature problem; use 1.4.1 or later.

## 1.4.0: settings
- **Settings window** (Tavrix menu > Settings…, Cmd+,): terminal font, size, theme (Tavrix Dark, Light, Solarized Dark, Dracula, Monokai), scrollback, cursor style and blinking, copy on select, plus connection defaults. Changes apply to open terminals immediately.
- **Session dialog is now tabbed** like MobaXterm's: Basic, Advanced, Terminal, Bookmark.
  - Advanced: jump host, keep-alive, compression, connect timeout, **start in folder** and **run command after login**.
  - Terminal: override any appearance setting for one session; blank means "use the default".
  - Bookmark: put the session in a **folder** in the sidebar (collapsible; remembered).
- Keep-alive is now on by default (every 30 s), so idle sessions are not silently dropped by routers, and a dead link is noticed after about 90 s instead of hanging.
- Startup folder/command are typed into the first terminal as you would type them, so they are visible; split panes do not repeat them. The file panel also starts in the startup folder.
- Fix: a second error from a dropped or failed connection could crash the app with a "JavaScript error in the main process" dialog. Connections now keep an error handler for their whole life.
- Saving a session now stores only known, validated fields; settings sent to the main process are clamped (font size 8-32, scrollback 0-100000, keep-alive 0-3600 s, timeout 5-120 s).
- Not covered by automated tests: the Settings menu item and its Cmd+, shortcut (the window it opens is).

## 1.3.0
- **Faster file panel over a network.** Measured on a simulated slow link: a 3,000-file folder 1.49 s -> 0.18 s at 40 ms round-trip latency and 4.2 s -> 0.5 s at 120 ms. Folder listings now keep several directory requests in flight instead of one per round trip.
- Opening a file takes about 2 round trips regardless of size (the size check and the open are sent together and the data is read in parallel pieces).
- Folders you have already visited show instantly from memory and refresh in the background; the new list replaces them only if something changed. Changes made in the app (new folder, rename, delete, upload) always show immediately.
- A slow reply for a folder you already left can no longer replace the one you are in.
- **Folders open with one click** (files: click selects, double-click edits).
- The path updates immediately when you click, and the list dims if the server is slow.
- Fix: Reload and the editor no longer read the file's size twice.

## 1.2.1
- Much smaller download: installers are now per CPU instead of one universal build. Apple Silicon **86 MB** (was 224 MB), Intel **94 MB**. Installed size drops from 521 MB to about 255 MB.
  - Separate `arm64` and `x64` disk images (the universal build carried two copies of the browser engine).
  - Only English strings are kept from Electron (about 25 MB).
  - Disk images use LZMA compression (`scripts/shrink-dmg.mjs`).
- The update notice picks the installer for your Mac's CPU.
- Not changed: memory use (Electron apps use a few hundred MB while running) and the feature set.

## 1.2.0
- Update notice: Tavrix checks this project's GitHub Releases ~10 seconds after launch and every 12 hours, and shows a bar when a newer version exists, with **Download**, **Release notes**, **Later** and **Skip this version**. It never installs anything by itself; Download opens the installer link in your browser.
- Tavrix menu: **Check for Updates…** (also reports "up to date" or errors) and **Check for Updates Automatically** (on by default; turn it off to stop all background requests).
- Only `https://github.com/farookhridoy/tavrix/...` links are ever opened, whatever the feed contains; odd version tags and look-alike hosts are ignored.
- The repository is now public (MIT).

## 1.1.0
- New file button and right-click entry: creates an empty `0644` file, opens it, and refuses to overwrite an existing one.
- Auto-save (checkbox in the editor bar, off by default, remembered): saves 1.5 s after you stop typing. If the file changed on the server it pauses and tells you rather than overwriting.
- Change detection: size and modification time (seconds) are recorded when a file is opened or saved. When the window regains focus, a clean editor reloads a changed file, a dirty editor is warned, and a deleted file is reported. Saving a changed file asks before overwriting. A Reload button takes the server version.
- "Make executable" button appears when a file starts with `#!` and has no executable bit.
- Fix: a file is no longer opened as text if it is binary, not valid UTF-8, or over 5 MB; saving such a file would have corrupted it.
- Known limits: a change within the same second that keeps the same size is not detected; the check and the write are separate calls, so a change landing between them is still possible.

## 1.0.0
- Port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D) tunnels per connection, from the Tunnels button. Listening on anything other than loopback asks for confirmation.
- Jump hosts (ProxyJump): pick another saved session to pass through, including chains (max 5; cycles refused). Each hop's host key is verified. Jump hosts use their saved credentials. `~/.ssh/config` imports single-alias ProxyJump entries.
- Split panes: several terminals per connection, side by side or stacked; typing `exit` closes only that pane.
- Snippets: saved commands inserted into the focused terminal. Multi-line snippets are pasted (bracketed paste) so nothing runs until you press Enter, unless the snippet is set to run immediately.
- Edit saved sessions (keeps the saved secret if the field is left blank).
- Fix: uploads and downloads now keep file permissions, so an executable script stays executable (uploads used to arrive as 644).
- 18 automated tests, including tunnels, SOCKS5, jump hosts and multi-shell against a real SSH server.

## 0.5.0
- Password or key passphrase is asked for at connect time when it isn't saved, and asked again if wrong. Secrets typed there are not stored, and passwords keep leading/trailing spaces.
- Encrypted private keys are validated up front, so "needs passphrase" and "wrong passphrase" are distinct from "unreadable key".
- Transfers can be cancelled; an interrupted file is removed and the session stays usable.
- `~/.ssh/config` hosts without a `User` use your local account name (as OpenSSH does); saved sessions with an empty username do too.
- Release docs now cover notarization with a keychain profile.

## 0.4.0
- Packaging with electron-builder: universal `.dmg` (arm64 + x86_64), app icon, trimmed bundle (only the Monaco files needed at runtime).
- Signing/notarization configured via environment variables (`npm run dist:release`); see docs/RELEASING.md.
- ssh2's optional native crypto addon is excluded so the universal build works; ssh2 uses its JS fallback.

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
