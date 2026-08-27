# byteln server directory

Community list of public `bytelnd` relays. Add yours via pull request.

## Entry format

```json
{
  "url": "wss://relay.example.com",
  "name": "Example Relay",
  "region": "eu",
  "maintainer": "github:someone",
  "clients": ["https://chat.example.com"]
}
```

`clients` is optional: web UI origins that may call `/health` (CORS) and open WS from that host. If omitted, `https://{relay-host}` is assumed.

## Rules

1. Your relay must expose `GET /health` returning HTTP 200.
2. WebSocket path is `/bucket/{id}`.
3. PRs that add or change a URL must pass the health-check Action (`.github/workflows/directory-health.yml` at the monorepo root).
4. Operators are responsible for their instance — see [`../docs/operator.md`](../docs/operator.md).

Verified badges / automatic prune cron are planned; not enforced in v1.
