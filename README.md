# byteln

Ephemeral E2E chat relay: a dumb WebSocket server that connects exactly two peers per bucket, plus a SvelteKit PWA that does all encryption and local history.

## Components

| Path | Role |
|---|---|
| [`server/`](server/) | `bytelnd` — Go relay binary |
| [`web/`](web/) | SvelteKit static PWA client |
| [`directory/`](directory/) | Community `servers.json` + health-check Action |
| [`docs/operator.md`](docs/operator.md) | Operator AUP / metadata guidance |

## Quick start (dev)

```bash
make dev-all
# alias: make dev
# bytelnd → :8990  |  web → :5173

# custom relay port:
make dev PORT=9000
```

Or separately:

```bash
# Terminal 1 — relay (default :8990)
cd server && go run ./cmd/bytelnd
# or: BYTELN_PORT=9000 go run ./cmd/bytelnd

# Terminal 2 — web
cd web && PUBLIC_DEFAULT_RELAY=ws://127.0.0.1:8990 npm run dev
```

Open the app, create a chat, share the link (includes `#key=…` fragment — never sent to the server).

## Build

```bash
make build-server   # server/bin/bytelnd
make build-web      # web/build
make test
docker compose up --build
```

Relay defaults to `wss://byteln.dev` in production. On `localhost` / `127.0.0.1`, the UI also lists **Local Dev Relay** (`ws://127.0.0.1:8990`) and prefers that. Override with `BYTELN_PORT` / `BYTELN_LISTEN` or `PUBLIC_DEFAULT_RELAY`.

CORS allowlist (in-memory): see [`docs/operator.md`](docs/operator.md). Env: `BYTELN_DIRECTORY_URL`, `BYTELN_CORS_ORIGINS`, `BYTELN_CORS_REFRESH`, `BYTELN_CHECK_WS_ORIGIN`.

## Self-host

1. Run `bytelnd` behind TLS (Caddy/nginx) with WebSocket upgrade support.
2. Host the static `web/build` output (or use the `web` Docker target).
3. Optionally submit a PR to add your instance to [`directory/servers.json`](directory/servers.json).

See [`docs/operator.md`](docs/operator.md) for acceptable-use and metadata notes.

## Protocol sketch

- `GET /health` → JSON status
- `WS /bucket/{id}?token={session}` → join/create; token reclaim within 30s
- Close code `4001` → bucket full
- Binary frames → opaque ciphertext (relayed)
- Text frames from server → control (`peer_join` / `peer_leave` / `slot`)

## Release

Push a version tag to publish binaries + web tarball via GitHub Actions:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Artifacts land on the GitHub Release: `bytelnd_*` (linux/darwin/windows × amd64/arm64), `byteln-web_*.tar.gz`, and `SHA256SUMS.txt`.

## Go dependencies

`server/third_party/` vendors `gobwas/ws` and `mailru/easygo` via `replace` directives for offline-friendly builds. When network allows, you can switch to module proxy versions and drop the replaces.
