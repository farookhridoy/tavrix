# Tavrix manual

Tavrix is a Mac app that puts an **SSH terminal**, a **file manager** and a **code editor** for your servers in one window. This manual covers everything it does. Use the contents list on the left to jump around, or press <kbd>F1</kbd> in the app to open it.

![The Tavrix window: sessions on the left, terminal and files in the middle, editor tabs below](images/main-window.jpg "The main window: saved sessions, a terminal, the file panel and an editor with tabs")

## Install

1. Download the installer for your Mac from the [Releases page](https://github.com/farookhridoy/tavrix/releases/latest):
   - **`…-arm64.dmg`** for Apple Silicon (M1 and later)
   - **`…-x64.dmg`** for Intel Macs

   Not sure which? Apple menu → **About This Mac** shows the chip.
2. Open the `.dmg` and drag **Tavrix** into **Applications**.
3. Open Tavrix. The first time, macOS may stop you; see below.

### The first launch warning

> **Do not skip this.** Tavrix is not signed by a paid Apple Developer account, so the first time you open a downloaded copy macOS shows **"Apple could not verify "Tavrix" is free of malware…"**. That is expected, and you only need to do this once.

1. Open Tavrix from Applications. When the warning appears, click **Done**. *Do not click Move to Trash.*
2. Open **System Settings → Privacy & Security** and scroll down to **Security**.
3. Click **Open Anyway** next to Tavrix and enter your password.
4. Open Tavrix again and click **Open**.

Prefer Terminal? This does the same thing:

```
xattr -dr com.apple.quarantine /Applications/Tavrix.app
```

### Verify your download

Compare the SHA-256 in the release notes with your file's. The two values must match exactly:

```
shasum -a 256 ~/Downloads/Tavrix-*.dmg
```

### Updates

Tavrix tells you when a newer version is published, with a blue bar at the top: **Download**, **Release notes**, **Later**, **Skip this version**. It opens the download in your browser; it never installs anything by itself. Use **Tavrix menu → Check for Updates…** to check right away.

## The window at a glance

| Area | What it does |
|---|---|
| **Title bar icons** (left) | Show or hide the sessions sidebar and the file panel |
| **Manual** (right) | Opens this manual |
| **Sessions sidebar** | Your saved servers, in folders. **+** adds one, **Import** reads `~/.ssh/config`, **⚙** opens Settings |
| **Snippets** | Saved commands you can insert with one click |
| **Tabs** | One tab per connection |
| **File panel** | The server's files for the connected tab |
| **Terminals** | One or more shells on the server |
| **Editor** | Opens below the terminals when you open a file, with a tab per file |
| **Status bar** | Messages, transfer progress, and the Split, Close pane and Tunnels buttons |

Every thin divider between panels can be dragged to resize it. Double-click a divider to reset it.

## Connect to a server

Click **+** in the sidebar. The dialog has four tabs, like the session settings in other SSH tools.

### Basic

![The Basic tab: host, port, username, password and a private key with a Browse button](images/session-basic.png "Basic: where to connect and how to log in")

- **Host**, **Port** (22 by default) and **Username**.
- **Password**, or a **private key**. Click **Browse…** to pick the key file: the file window opens in your `~/.ssh` folder with hidden files shown. Typing `~/.ssh/id_ed25519` works too.
- Under the key field Tavrix says what you picked: a private key, an **encrypted** private key (you will be asked for its passphrase when you connect), a **public** key (`.pub`, which will not work; choose the matching private file), or not a key at all.

![Choosing a private key: Tavrix confirms what kind of key it is](images/key-browse.png "After picking a key, Tavrix tells you what it is")

**Save this session** (on the Bookmark tab) stores the session. Passwords and passphrases are encrypted with the macOS Keychain; they are never written as plain text. If you do not save a password, Tavrix asks for it while connecting. Wrong passwords are retried on the same connection, up to three times.

### Advanced

![The Advanced tab: jump host, keep-alive, compression, timeout, start folder and a command](images/session-advanced.png "Advanced: the connection options")

- **Jump host**: connect through another saved session first (a bastion). Chains work; each hop's host key is checked. Jump hosts use their saved credentials.
- **Keep-alive**: sends a tiny message every 30 seconds by default so routers and firewalls do not drop an idle session. `0` turns it off. A dead connection is noticed after about three missed messages.
- **Compression** and **Connect timeout** (20 seconds by default). Time you spend typing a password or answering the host-key question does not count toward the timeout.
- **Start in folder**: after login, Tavrix types `cd` to this folder in the first terminal, and the file panel opens there.
- **Run command after login**: typed into the first terminal. Both are typed where you can see them; nothing is hidden. Split terminals do not repeat them.

### Terminal

![The Terminal tab: font, size, theme, scrollback, cursor and copy-on-select, each set to Default](images/session-terminal.png "Terminal: look of this one session")

Override the look of the terminal for this session only. Anything left on **Default** follows the global setting (see [Settings](#settings)). Handy for giving production servers a red-ish theme.

### Bookmark

![The Bookmark tab: a sidebar folder and the Save this session option](images/session-bookmark.png "Bookmark: put the session in a sidebar folder")

Choose a **folder** for the session. Folders appear in the sidebar and can be collapsed; Tavrix remembers which are open.

### Host keys: is this really my server?

The first time you connect to a server, Tavrix shows its **fingerprint** and asks whether to trust it. If a trusted server later presents a *different* key, Tavrix blocks the connection with a warning, because that can mean someone is intercepting the connection. If the server was legitimately reinstalled, remove its line from `known_hosts.json` in the app data folder (see [Where Tavrix keeps things](#where-tavrix-keeps-things)).

### Importing from `~/.ssh/config`

Click **Import** in the sidebar. Tavrix adds each concrete `Host` it finds (wildcards are skipped) with its `HostName`, `User`, `Port` and `IdentityFile`. A host without a `User` uses your Mac account name, as OpenSSH does. A `ProxyJump` that names a single other host is linked as a jump host; longer chains are reported and left for you to set.

### Servers with one-time codes, or without passwords

Some servers ask for a **one-time code** after the password, or accept passwords only through "keyboard-interactive" login. Tavrix handles both and asks you for each answer. If a server accepts only keys, Tavrix says so ("it offers: publickey. Use a private key.") instead of trying passwords.

## Terminal

The terminal behaves like Terminal.app: <kbd>⌘C</kbd> copies, <kbd>⌘V</kbd> pastes, and there is scrollback. Turn on **Copy on select** in Settings to copy as soon as you select text. Typing `exit` in the last terminal ends the connection.

### Split terminals

![Three terminals on one connection, side by side, with dividers you can drag](images/split-panes.jpg "Several terminals share one connection and can be resized")

- **Split →** puts a new terminal beside the current ones; **Split ↓** stacks them. A tab uses one direction at a time.
- **Close pane** closes the focused terminal.
- Every terminal shares **one** network connection, so splitting does not open more connections to your server.
- **Drag a divider** to resize; **double-click** it to make the terminals equal again. The arrow keys move a focused divider by 20 pixels (hold <kbd>Shift</kbd> for 100).

## Files

The panel on the left of a connected tab shows the server's files.

- **Click a folder** to open it. **Double-click a file** to edit it.
- **Right-click** a file or folder for **Download…**, **Rename…**, **Permissions…** (octal, like `644` or `755`) and **Delete**. Deleting a folder asks first and removes everything inside it.
- **Right-click the empty area**, or use the buttons at the top: **↑** parent folder, **⟳** refresh, **+ File**, **+ Folder**, **Upload**.
- **Upload** by clicking *Upload*, or by **dragging files and folders from Finder** onto the panel. If a name already exists you are asked whether to replace it.
- **Download** a file or a whole folder; you choose where it goes. A progress bar shows the transfer with a **Cancel** button. Cancelling removes the half-copied file.
- File permissions are kept in both directions, so an executable script stays executable. Symbolic links are skipped in transfers.
- Folders you have visited show instantly and refresh quietly behind; a big folder is read with several requests at once, which makes a big difference on a distant server.

## Editor

Open a file and the editor appears below the terminals.

![Several files open in editor tabs, with syntax highlighting and an unsaved marker](images/editor-tabs.jpg "Each open file gets its own tab; the dot marks unsaved changes")

- **Tabs**: every file opens in its own tab. Click to switch, **×** (or middle-click) to close. A dot ● marks unsaved changes; closing a file with unsaved changes asks first. Cursor position and scroll are remembered per file.
- **Syntax highlighting** by file extension.
- **Save** with <kbd>⌘S</kbd> or the **Save** button. **Auto-save** (checkbox in the editor bar) saves 1.5 seconds after you stop typing; it is off by default.
- **Changes on the server are noticed.** Tavrix remembers each file's size and time when you open or save it. When you come back to the window, a file you have not edited reloads itself if it changed on the server; a file with your unsaved edits is only flagged. Saving over a changed file asks before overwriting, and auto-save pauses instead of overwriting. **Reload** takes the server's version.
- **Make executable** appears for a file that starts with `#!` but is not executable.
- Binary files, files that are not valid UTF-8 text, and files over 5 MB are not opened as text, because saving them would damage them. Download them instead.
- **New files** are created empty with permissions `644`.

### Full-screen editor

![The editor using the whole window](images/fullscreen-editor.jpg "Full-screen editor: everything else steps aside")

Click **⤢ Full screen** in the editor bar, choose **View → Full Screen Editor**, or press <kbd>⌘⇧F</kbd>. The sidebar, file panel and terminals step aside. Press <kbd>Esc</kbd> (or click **⤡ Exit full screen**) to bring them back. This is separate from the macOS full-screen window button.

### Making room

Drag the divider between the terminals and the editor up or down. Tavrix remembers the proportion for new tabs.

## Tunnels (port forwarding)

Click **Tunnels** in the status bar of a connected tab.

![The Tunnels window with one running tunnel and the form to add another](images/tunnels.png "Tunnels: forward ports through the server")

| Type | What it does | Example |
|---|---|---|
| **Local (-L)** | Opens a port on your Mac that leads to a host reachable *from the server* | Reach a database that only the server can see: listen on `5433`, destination `db.internal:5432`, then point your app at `localhost:5433` |
| **Remote (-R)** | Opens a port on the *server* that leads back to a service on your Mac | Show a dev site running on your Mac at `localhost:3000` to someone on the server |
| **Dynamic (-D)** | A SOCKS5 proxy on your Mac that sends traffic out through the server | Set `localhost:1080` as the SOCKS proxy in a browser to browse from the server's network |

Listening addresses default to `127.0.0.1` (only your Mac). Listening on anything else asks for confirmation, because anyone who can reach your Mac could then use the tunnel. Use **Stop** to close a tunnel; tunnels also end with the connection.

## Snippets

![The snippet editor: a name, the text to insert, and an option to press Enter for you](images/snippets.png "Snippets: commands you type often (they are listed in the sidebar)")

Click **+** next to **Snippets** to save a command. Click a snippet to insert it into the terminal that has focus. A snippet is **typed but not run** unless you tick *Press Enter after inserting*, and a multi-line snippet is pasted as one block, so nothing executes until you press <kbd>Enter</kbd>.

## Settings

Open Settings with the **⚙** button in the sidebar, or <kbd>⌘,</kbd>.

![The Settings window](images/settings.png "Settings: how every terminal looks, and connection defaults")

| Setting | Notes |
|---|---|
| **Font**, **Font size** | Any installed monospace font; 8 to 32 |
| **Theme** | Tavrix Dark, Light, Solarized Dark, Dracula, Monokai |
| **Scrollback lines** | 0 to 100,000 |
| **Cursor**, **Cursor blinks** | Block, bar or underline |
| **Copy on select** | Copies selected text automatically |
| **Keep-alive**, **Compression**, **Connect timeout** | Defaults for all sessions; a session can override them on its Advanced tab |

Changes apply to open terminals immediately. **Reset to defaults** fills the form with the original values; nothing changes until you press **Save**.

## Keyboard and mouse

| Action | Shortcut |
|---|---|
| Settings | <kbd>⌘,</kbd> |
| Show or hide the sessions sidebar | <kbd>⌘B</kbd> |
| Show or hide the file panel | <kbd>⌘⇧B</kbd> |
| Full-screen editor on or off | <kbd>⌘⇧F</kbd> |
| Save the open file | <kbd>⌘S</kbd> |
| Open this manual | <kbd>F1</kbd> |
| Leave full-screen editor, close the tour | <kbd>Esc</kbd> |
| Resize a divider with the keyboard | focus it, then <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> (<kbd>Shift</kbd> for bigger steps) |
| Reset a divider | double-click it |
| Close a file tab | click **×**, or middle-click the tab |

## The quick tour

The first time you open Tavrix, a short tour points out the main controls.

![A step of the quick tour, with the highlighted control and a short explanation](images/tour.png "The quick tour highlights each control in turn")

Close it any time with **✕**, **Skip tour** or <kbd>Esc</kbd>; it will not come back by itself. Bring it back from **Help → Quick Tour** or the **Quick tour** button in this manual.

## Where Tavrix keeps things

Everything lives in `~/Library/Application Support/Tavrix/`:

| File | Contents |
|---|---|
| `sessions.json` | Saved sessions. Passwords and passphrases are stored encrypted with the macOS Keychain, never as plain text |
| `known_hosts.json` | Server fingerprints you trusted |
| `settings.json` | Your settings and whether you have seen the tour |
| `snippets.json` | Your snippets |

To start fresh, quit Tavrix and delete that folder. Deleting the app itself leaves it behind.

## Privacy

Tavrix has no accounts, analytics or telemetry. Its **only** automatic network request is the update check: an anonymous request to `api.github.com` for this project's latest release, at launch, every 12 hours, and when you return to the window after an hour. GitHub sees your IP address, and the request carries the Tavrix version. Turn it off with **Tavrix menu → Check for Updates Automatically**. Everything else goes only to the servers you connect to.

## Troubleshooting

**macOS says Tavrix "Not Opened" or "damaged".** See [The first launch warning](#the-first-launch-warning). Click **Done**, then **Open Anyway** in System Settings → Privacy & Security.

**"Authentication failed".** Check the username and password. If the server accepts only keys, pick your private key with **Browse…**. If you chose a `.pub` file, choose the private file next to it.

**"Host key has CHANGED".** The server presented a different key than the one you trusted. If you did not reinstall or move the server, do not connect. If you did, remove its entry from `known_hosts.json`.

**The connection drops when idle.** Keep-alive is on at 30 seconds by default. Lower it on the session's Advanced tab if a network is more aggressive, or check that the server answers keep-alives.

**The server blocks my IP address a few minutes after I connect.** That is a security rule on the server or its provider (for example *fail2ban*, a firewall rate limit, or a cloud "security group"); a web terminal from the provider's own site works because it runs inside their network. Tavrix uses a single connection per session (terminals, file panel and editor all share it), and asks for a password on that same connection, so it makes fewer connections than most tools. To find the cause:
1. Compare with Terminal.app: run `ssh -v user@host`. If it is blocked too, the rule is not about Tavrix.
2. On the server, check what banned you: `sudo fail2ban-client status sshd` and `sudo tail /var/log/auth.log`. Unban with `sudo fail2ban-client set sshd unbanip YOUR.IP`.
3. Prefer a **key** over a password, and avoid several wrong password attempts in a row.
4. Ask your provider whether connections are limited per IP.

**The file panel is slow.** Each folder needs a couple of round trips to the server, so very distant servers feel slower. Folders you have already visited open instantly.

**A file will not open in the editor.** It is binary, not UTF-8 text, or over 5 MB. Download it instead.

**Start over.** Quit Tavrix and delete `~/Library/Application Support/Tavrix`.

## Getting help

- [Report a problem or suggest something](https://github.com/farookhridoy/tavrix/issues)
- [Release notes](https://github.com/farookhridoy/tavrix/releases)
- The project page and source: [github.com/farookhridoy/tavrix](https://github.com/farookhridoy/tavrix)
