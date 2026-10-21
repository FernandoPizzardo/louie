# Louie desktop (Electron)

Desktop shell for the engine and the web UI. Linux is the first target.

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

## Build packages (Linux)

Run on the Linux machine that will use the packages:

```sh
cd electron
npm install
npm run dist       # AppImage and .deb in electron/dist/
```

The packages bundle `bin/` and `lib/` as `resources/engine` and `web/dist` as
`resources/ui`.

## Not yet included

- CA trust on Linux (system store and NSS for browsers) — Phase 4.
- MCP data directory on Linux (`~/.local/share/...`) — Phase 4.
- Code signing and auto-update.
