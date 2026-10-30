# Louie web client

React + TypeScript + Vite client of the engine's control API, bundled into the
Electron desktop shell (`../electron`) for Linux and Windows. On macOS the
SwiftUI app (`../native`) is the primary UI; this client exists for the
platforms it cannot run on.

The client talks **only** to the token-authenticated loopback control API
(`GET/POST /api/*`, `GET /events` SSE) and never imports engine code. See
`../docs/control-api.md` for the contract.

## Develop

```sh
npm install
LOUIE_ENGINE=http://127.0.0.1:8889 npm run dev   # proxies /api and /events to a running engine
```

Start an engine first: `node ../bin/charles-clone.js --proxy 8888`.

## Build & lint

```sh
npm run build   # tsc -b && vite build -> dist/
npm run lint    # oxlint
```

`../electron` runs `npm run build` here and serves `dist/`.
