# Operator guide — byteln relay

You are running a content-blind WebSocket relay. You never see message plaintext. Enforcement is per-instance.

## What the server retains

By default `bytelnd` keeps **only in-memory** state:

- Bucket IDs and which slots are occupied
- Session tokens for slot reclaim (bucket lifetime)
- Peer connection objects
- Optional short RAM buffer of ciphertext when one peer is alone (TTL, default 60s)
- Transient connection metadata needed for rate limits (IP → create/bucket counters)

**Nothing is written to disk** by the binary. If you put a reverse proxy or OS audit log in front, that is your choice — document it for your users.

Recommended: do **not** log WebSocket payloads. If you log connections, prefer coarse metrics (counts, durations) over full IP retention; if you retain IPs, publish a retention window (e.g. 24–72h) and stick to it.

## Legal / disclosure posture

Under a lawful request you typically can produce, at most:

- That a bucket ID existed and when peers connected (if you logged that)
- Connection metadata you chose to keep

You **cannot** produce message content: the relay only ever sees ciphertext, and even that is not persisted.

## Acceptable use (template)

Operators may adopt or adapt:

1. No using this relay to harass, threaten, or traffic in illegal content.
2. Automated bucket farming / DoS is prohibited; the binary rate-limits creates and concurrent buckets per IP.
3. Recipients may **report a bucket ID** (no content) to the operator for a ban.
4. The operator may terminate buckets or ban IPs based on reports and traffic patterns without decrypting anything.
5. There is no global enforcement across the byteln directory — each instance is independent.

## TLS / WSS (nginx)

`bytelnd` speaks plain WS. Terminate TLS in front — see [`deploy/nginx-wss.conf`](../deploy/nginx-wss.conf) for a sample `wss://` reverse proxy (`/bucket/`, `/health`).

## Process manager (PQPM)

On a VPS with [PQPM](https://github.com/pqpm/pqpm), merge [`deploy/pqpm.toml`](../deploy/pqpm.toml) into `~/.pqpm.toml`, fix `USER` paths, then:

```bash
pqpm start bytelnd
pqpm status
```

## Reporting path

Clients can open a `mailto:` report with the bucket ID only. Publish a contact address for your instance (README, `/`, or proxy landing page).

## CORS / web origins

`bytelnd` keeps an **in-memory** browser Origin allowlist (no database):

1. Starts with embedded defaults (`https://byteln.com`, localhost / 127.0.0.1).
2. On startup (async) and every `BYTELN_CORS_REFRESH` (default 6h), fetches  
   `BYTELN_DIRECTORY_URL` (default: GitHub `directory/servers.json`).
3. Derives allowed origins from each relay `url` (`wss://host` → `https://host`), plus optional per-entry `clients: ["https://…"]`.
4. Merges `BYTELN_CORS_ORIGINS` (comma-separated) for private web UIs.

`/health` echoes `Access-Control-Allow-Origin` only for allowed Origins.  
WebSocket upgrades with a non-empty `Origin` are rejected if not allowlisted (`BYTELN_CHECK_WS_ORIGIN=true` by default). Empty Origin (non-browser) is allowed.

If GitHub is unreachable, the previous/embedded list is kept.
