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

Open the app, create a chat, share the link and room PIN separately. The encryption key lives in the URL fragment (`#key=…`); the room PIN is verified locally and never sent to the relay.

## Build

```bash
make build-server   # server/bin/bytelnd
make build-web      # web/build
make test
docker compose up --build
```

Relay defaults to `wss://byteln.com` in production. On `localhost` / `127.0.0.1`, the UI also lists **Local Dev Relay** (`ws://127.0.0.1:8990`) and prefers that. Override with `BYTELN_PORT` / `BYTELN_LISTEN` or `PUBLIC_DEFAULT_RELAY`.

Web Push (content-free, opt-in): when a peer is away, the relay sends an empty push to their browser so the PWA can show "New message in a chat". Endpoints live in memory for the bucket's lifetime only. Env: `BYTELN_PUSH`, `BYTELN_VAPID_PRIVATE_KEY`, `BYTELN_VAPID_SUBJECT`, `BYTELN_PUSH_MIN_INTERVAL` — see [`docs/operator.md`](docs/operator.md#web-push).

CORS allowlist (in-memory): see [`docs/operator.md`](docs/operator.md). Env: `BYTELN_DIRECTORY_URL`, `BYTELN_CORS_ORIGINS`, `BYTELN_CORS_REFRESH`, `BYTELN_CHECK_WS_ORIGIN`.

## Self-host

1. Run `bytelnd` behind TLS (Caddy/nginx) with WebSocket upgrade support.
2. Host the static `web/build` output (or use the `web` Docker target).
3. Optionally submit a PR to add your instance to [`directory/servers.json`](directory/servers.json).

See [`docs/operator.md`](docs/operator.md) for acceptable-use and metadata notes.

## Protocol sketch

- `GET /health` → JSON status
- `GET /push-key` → `{"enabled":true,"key":"<VAPID public key>"}`
- `WS /bucket/{id}?token={session}` → join/create; token reclaim within 30s
- Room PIN (`pv` in URL hash) gates the client locally; relay tokens are derived from key+PIN+seat
- Close code `4001` → bucket full
- Binary frames → opaque ciphertext (relayed)
- Text frames from server → control (`peer_join` / `peer_leave` / `slot`)
- Text frames from client `push_sub` / `push_unsub` → consumed by the relay, never forwarded

## Release

Push a version tag to publish binaries + web tarball via GitHub Actions:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Artifacts land on the GitHub Release: `bytelnd_*` (linux/darwin/windows × amd64/arm64), `byteln-web_*.tar.gz`, and `SHA256SUMS.txt`.

## Go dependencies

Server vendors `gobwas/ws` and `mailru/easygo` under `server/third_party/` (plain files, via `go.mod` `replace`). This keeps CI/offline builds reliable without nested git submodules.
