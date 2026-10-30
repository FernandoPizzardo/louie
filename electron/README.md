# Louie desktop (Electron)

Desktop shell for the engine and the web UI, for the platforms the SwiftUI app
(`../native`, macOS) cannot run on: **Linux and Windows**.

The main process starts the engine as a child process (Electron's bundled
Node, `ELECTRON_RUN_AS_NODE=1`), then serves `web/dist` and forwards `/api` and
`/events` to the engine with the token attached. The token stays in the main
process, and the UI server only accepts requests from its own origin.

## Run from source

```sh
cd electron
npm install
npm start          # builds web/ then launches the app
```

Environment overrides (useful for testing):

- `LOUIE_PROXY_PORT` — proxy port (default `8888`)
- `LOUIE_USER_DATA` — profile directory (default: Electron's `userData`, on
  Linux `~/.config/Louie`)

## Build packages

Build on the OS that will use the packages (electron-builder does not fully
cross-compile native pieces):

```sh
cd electron
npm install

npm run dist:linux   # AppImage and .deb in electron/dist/
npm run dist:win     # NSIS installer and portable .exe in electron/dist/
```

`npm run dist` is an alias for `dist:linux`. The packages bundle `bin/` and
`lib/` as `resources/engine` and `web/dist` as `resources/ui`.

## Not yet included

- CA trust on Linux/Windows (system store, NSS for browsers, Windows cert
  store) — Phase 4.
- MCP data directory on Linux (`~/.local/share/...`) and Windows
  (`%APPDATA%/...`) — Phase 4.
- Code signing and auto-update (both platforms).
