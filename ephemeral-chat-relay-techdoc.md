# byteln — Technical Design Doc

**Project:** byteln
**GitHub org:** [github.com/byteln](https://github.com/byteln)
**Status:** Draft v1
**Date:** 2026-08-27

## 1. Overview

byteln is a single-binary, self-hostable chat relay server. The
server has no database, no accounts, and no message persistence — it
only relays encrypted bytes between exactly two connected clients
("a bucket"). Clients (web app / mobile app) do all encryption,
decryption, and local storage. Anyone can self-host a byteln instance
and list it publicly via a community-maintained directory on GitHub,
similar in spirit to the Mastodon/Matrix instance-picker model.

**Design pillars**
- Server is a dumb, stateless relay — never sees plaintext.
- No user accounts, ever. "Users" are just whichever two devices hold
  the two connection slots in a bucket.
- Nothing written to disk server-side. All state is in-memory and
  dies with the process or the bucket.
- Federation via a public server list (GitHub PR-based), not central
  infrastructure.
- History portability is solved client-side (export/import), not by
  server-side backups.

---

## 2. System Components

| Component | Description |
|---|---|
| **Relay server** | Single Go binary. WebSocket endpoint. Holds buckets in memory. |
| **Web client** | SPA (React or vanilla). Web Crypto API for E2E encryption. |
| **Mobile client** | PWA wrapper or Capacitor build of the same web client. |
| **Server directory** | `servers.json` in a public GitHub repo, updated via PR. |

---

## 3. Bucket Model

A **bucket** is an ephemeral room identified by a short random ID
(e.g. `xk3n9d2a`), holding at most **2** active WebSocket connections.

```
wss://relay.example.com/bucket/xk3n9d2a
```

Server-side state per bucket (in-memory only):

```go
type Bucket struct {
    ID       string
    Peers    [2]*websocket.Conn // slot A, slot B
    Created  time.Time
    LastSeen time.Time
}
```

**Rules**
- 3rd connection attempt to a full bucket → rejected (`409` or close
  code `4001`).
- Server relays raw frames from one peer to the other — no parsing,
  no storage, no logging of payload.
- Bucket is deleted from memory when both peers disconnect (or after
  an idle TTL, e.g. 10 min, whichever first).
- Optional: if only one peer is connected, hold their outgoing
  messages in a small RAM buffer with a short TTL (e.g. 60s) so the
  second peer doesn't miss messages sent moments before joining. This
  is a UX tradeoff against strict "never buffer" — configurable.

**Reconnect / slot ownership**
To stop a flaky connection from losing its slot to a third party:
- On connect, client presents a short-lived session token (generated
  client-side at bucket creation, held locally).
- Server maps `token → slot` for the bucket's lifetime, allowing the
  same client to reclaim its slot within a grace window (e.g. 30s)
  after a drop, before the slot opens up.

---

## 4. Encryption Model (E2E, client-side only)

The server must be cryptographically incapable of reading content,
even if compromised, subpoenaed, or malicious.

- **Key generation**: on bucket creation, the client generates a
  random symmetric key (AES-256-GCM).
- **Key distribution**: key is placed in the URL **fragment**
  (`#key=...`), never the path or query string — fragments are not
  sent to the server in an HTTP/WS request, so the server never
  receives the key even accidentally.
- **Message encryption**: every message is AES-GCM encrypted
  client-side before it hits the WebSocket. Server relays ciphertext
  only.
- **Bucket ID vs. key**: bucket ID (routing) and key (decryption) are
  separate concerns. Sharing the full link shares both; you could
  also design a flow where the ID and key are shared through
  different channels for extra safety.

---

## 5. History Portability (Export / Import)

No server-side backup. History lives only on-device, and moves
between devices as a **user-controlled encrypted file**, transferred
over whatever channel the user likes (email, AirDrop, USB, cloud
drive).

**Export**
1. Read local chat history (IndexedDB on web, SQLite/plist on
   mobile).
2. Serialize to JSON.
3. Encrypt with a key derived from the session key via HKDF (a
   distinct "backup key," not the live session key — so a leaked
   export file doesn't also compromise a still-active session).
4. Write as a single portable file.

```json
{
  "version": 1,
  "bucket_id": "xk3n9d2a",
  "exported_at": "2026-08-27T12:00:00Z",
  "nonce": "<base64>",
  "ciphertext": "<base64 AES-GCM blob>"
}
```

**Import**
1. User opens the file in the app (share-to-app / file picker).
2. App re-derives or prompts for the backup key.
3. Decrypts, validates schema/version, merges into local store.
4. If the bucket ID is still active, optionally offers to reconnect
   the live session using the embedded bucket ID.

---

## 6. Server Directory (Federation)

The `byteln` GitHub org hosts a public repo containing `servers.json`.
Anyone self-hosting an instance submits a PR to add their entry.

```json
[
  {
    "url": "wss://relay.example.com",
    "name": "Example Relay",
    "region": "eu",
    "maintainer": "github:someone"
  }
]
```

**Client behavior**
- Fetch and cache `servers.json` on launch; don't block startup if
  GitHub is unreachable (fall back to cache or manual URL entry).
- Optionally do a live health ping against listed servers before
  showing them as selectable.
- Support a custom/manual server URL for private or unlisted
  self-hosted instances.

**Repo hygiene**
- CI check (GitHub Action) on each PR: attempt a WS handshake against
  the submitted URL, fail the check if unreachable.
- Periodic cron job to re-check and prune long-dead entries.
- Optional non-binding "verified" badge for longstanding, responsive
  servers — cosmetic trust signal only, not a security boundary.

---

## 7. Abuse & Safety Considerations

The server is content-blind by design, which rules out message-level
moderation. This is a known, accepted tradeoff of E2E systems (same
posture as Signal, Session, etc.), and it also limits the *kind* of
abuse the system is useful for: it's a 1:1 relay with no discovery,
no broadcast, and no public content — architecturally closer to a
phone line than a platform, which removes the amplification/audience
dynamics that make broadcast tools more attractive for coordinated
misuse.

What's still possible at the **metadata layer** (server sees
connections, not content):

- **Rate limiting**: throttle bucket-creation rate per IP; optional
  CAPTCHA/proof-of-work on creation to deter automated abuse.
- **Connection abuse controls**: cap concurrent buckets per IP,
  timeouts on idle/unused buckets.
- **Reporting path**: since a recipient *can* read their own
  conversation, provide an in-client "report this bucket" action that
  flags the bucket ID to the relay operator for a ban — without the
  operator ever decrypting anything.
- **Operator responsibility & transparency**: each self-hoster is
  responsible for their instance, similar to Mastodon instance admins
  or Tor relay operators. Document clearly:
  - what metadata (IPs, timestamps, connection logs) an operator
    typically retains and for how long,
  - that operators cannot produce message content under legal
    request, only connection metadata, if any is kept,
  - a recommended acceptable-use policy template for operators to
    adopt or adapt.
- **No central chokepoint**: because the project is federated, there
  is no single "app-wide" enforcement point — enforcement happens per
  instance, which should be stated plainly to anyone deploying or
  using the software.

---

## 8. Suggested Stack

| Layer | Choice | Why |
|---|---|---|
| Server (`bytelnd`) | Go, raw `net.Listen` + `gobwas/ws` (zero-copy upgrade) | Single static binary, easy cross-compilation, minimal per-connection overhead — see §9 |
| Web client | Vanilla JS/TS or React SPA + Web Crypto API | No backend dependency, works as installable PWA |
| Mobile | PWA / Capacitor wrapper of the web client | One codebase instead of separate native apps |
| Distribution | Single binary + Dockerfile | Trivial self-hosting |
| Directory | Static `servers.json` in GitHub + Action for health checks | No infra needed, PR-based governance |

---

## 9. Implementation Notes — WebSocket Efficiency

`bytelnd` doesn't need to handle millions of connections per bucket
(there are only ever 2), but a single public instance may host many
*buckets* concurrently, so per-connection overhead still matters for
self-hosters running on modest hardware (a $5 VPS, a Raspberry Pi,
etc). The reference here is Sergey Kamardin's well-known Mail.Ru
writeup on scaling a Go WebSocket server to millions of connections
([freeCodeCamp, "A Million WebSockets and Go"](https://www.freecodecamp.org/news/million-websockets-and-go-cc58418460bb/)),
which is a useful checklist even at small scale.

**Naive approach (what to avoid)**
A standard implementation spawns a dedicated reader goroutine and
writer goroutine per connection, each holding its own I/O buffer
(commonly 4 KB via `bufio`). Both goroutines sit blocked most of the
time — bucket connections are long-lived but mostly idle between
messages — so the stacks and buffers are paid for even while doing
nothing.

**Techniques worth adopting in `bytelnd`, roughly in priority order**

1. **Netpoll-driven reads instead of a permanently blocked reader
   goroutine.** Use Go's underlying epoll/kqueue integration (via a
   library like `github.com/mailru/easygo/netpoll` or equivalent) so
   a goroutine is only spun up when there's actually data to read on
   a socket, rather than parking a goroutine + buffer per connection
   for the connection's entire lifetime.
2. **Lazy writer goroutines.** Only start a writer goroutine (and
   allocate its buffer) at the moment there's something to send, and
   let it exit once the send queue drains, rather than keeping one
   running per connection at all times.
3. **Bounded goroutine pool for packet handling.** Cap the number of
   packets processed concurrently with a worker pool. This protects
   a self-hosted instance from resource exhaustion if many buckets
   suddenly get chatty at once, and gives you a natural backpressure
   point instead of unbounded goroutine growth.
4. **Zero-copy WebSocket upgrade.** Rather than the standard
   `net/http` server (which allocates read/write buffers per request
   just to process the Upgrade handshake), use a library that
   supports upgrading directly on a raw `net.Conn` from `net.Listen`
   — e.g. `github.com/gobwas/ws`, built specifically for this. This
   matters less for byteln's low connection counts, but it's a
   cheap win and keeps the binary lean.
5. **Rate-limit `Accept()`/`Upgrade()` under load**, not just
   established connections — schedule accepts through the same
   worker pool with a short timeout, so a connection storm degrades
   gracefully (reject/retry) instead of taking the process down.
   This dovetails with the abuse-mitigation goals in §7 (bucket
   creation rate limiting) — the same pool-based backpressure serves
   both efficiency and abuse resistance.

**Practical takeaway for byteln:** because each bucket only ever has
2 peers, none of this is required to make a basic implementation
*work*. But since the project is meant to be self-hosted on cheap,
small hardware by many independent operators (not run by you at
large scale), keeping the per-connection footprint low is directly
in service of the "easy to self-host" goal — it's the difference
between an instance comfortably handling a few thousand idle buckets
on a $5 VPS versus needing a beefier box for the same load. Treat
items 1–3 as worth doing from the start; items 4–5 as
optimize-when-it-matters.

---

## 10. Open Questions

- Buffer-for-late-peer TTL: how long, if at all, should the server
  hold a message when only one peer is connected?
- Should bucket IDs be user-chosen (memorable, e.g. "movie-night") or
  always random? User-chosen names increase collision/guessing risk
  per server.
- Should there be an optional "verified operator" trust signal, and
  if so, what (if anything) should it actually gate?
- Backup key derivation: confirm HKDF parameters and whether a
  passphrase-based option is offered for import on a device that
  never had the original link.
