# @dendrop/desktop

The Windows 11 and Linux app. It's a small Electron shell around the web client: it opens your
Dendrop server's own pages (the built `packages/web` the server serves), so the app always
matches the server and nothing in the web client is forked.

## What it does

- **Server setup.** The first start asks for your server's address (`https://chat.example.com`,
  or `tower:8080` on the LAN) and checks a Dendrop server answers there before saving it.
  If the server can't be reached later, a "the den is quiet" page retries every 30 seconds.
- **Sign-in** happens in the window, including TinyAuth single sign-on. Links in messages open
  in your normal browser, never inside the app.
- **Private notifications.** The app keeps its own connection to the gateway (with the window's
  sign-in), so new messages notify even while the window is closed to the tray. Notifications
  **never include the message text**. They say "New message", or "New message from Sam" if you
  turn on *Show who messages are from*. The page's own `Notification` API is blocked so the
  web client can't show message text by accident. Bursts in one chat notify once per 15 seconds,
  and the tray icon, taskbar overlay (Windows) and launcher badge (Linux) show unread messages.
- **Tray.** Closing the window keeps Dendrop in the tray. Right-click the raccoon for:
  open, open when this PC starts, keep running when closed, message notifications,
  show who messages are from, install updates automatically, change server, check for updates, quit.
- **Open when the PC starts** (off by default) starts hidden in the tray. On Windows it's the
  usual Run entry (removed by the uninstaller); on Linux it's `~/.config/autostart/dendrop.desktop`.
- **Updates.** Every few hours the app asks the server for builds at `/api/clients`, downloads a
  newer one of the same kind (installer, portable .exe or AppImage), checks it against the
  `SHA256SUMS` on that version's GitHub release, and installs it when the window is closed or you
  choose *Restart to update*. The .deb updates through your package manager instead.
- `window.dendrop` (from `src/preload.ts`) lets the web client read and change these settings later,
  for a desktop section in its own settings page. It only answers the configured server's pages.

Keys: Ctrl + / Ctrl − / Ctrl 0 zoom, F5 or Ctrl R reload, Esc backs out of a sign-in page.

## Developing

```sh
npm install                 # from the repository root
npm run dev:server          # a server on :8080 to point the app at
npm run dev:desktop         # builds and starts the app
npm test -w @dendrop/desktop
```

Settings live in `settings.json` in the app's data folder (`%APPDATA%\Dendrop` or `~/.config/Dendrop`).
`allowUnverifiedUpdates: true` there installs updates that aren't on a GitHub release (your own builds).

The icons in `build/` are rendered from the SVGs next to them with `node scripts/icons.mjs`.
They use the placeholder raccoon mark from `packages/web/public/favicon.svg`; when the theme work
replaces it, update the SVGs and re-render.

## Building installers

```sh
npm run dist:win -w @dendrop/desktop     # Dendrop-Setup-x.y.z.exe and Dendrop-x.y.z-portable.exe (on Windows)
npm run dist:linux -w @dendrop/desktop   # Dendrop-x.y.z-linux-x86_64.AppImage and Dendrop-x.y.z-linux-amd64.deb
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds both on GitHub, writes
`SHA256SUMS` and attaches everything to a release. The builds aren't code-signed, so Windows
SmartScreen asks once ("More info", "Run anyway").

## Not done yet

- **Server side of updates.** The server doesn't serve `/api/clients` yet; until it does, update
  checks just report an error in the tray and nothing installs. Since the repository is private,
  the GitHub `SHA256SUMS` check also needs either a public release or another source of trust
  (for example a signing key), so this needs a decision before the first release.
- Global keybinds (push-to-talk, mute, deafen) and pop-out chats wait for calls and the chat UI.
- Opening the right conversation when you click a notification needs routes in the web client.
