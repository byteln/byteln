package protocol

// WebSocket close codes (application range).
const (
	CloseBucketFull     = 4001
	CloseBadBucketID    = 4002
	CloseRateLimited    = 4003
	CloseIdleTimeout    = 4004
	CloseServerShutdown = 4005
	// CloseRateExceeded is sent when a connection exceeds its per-connection
	// throughput cap (bytes/sec or frames/sec). Distinct from CloseRateLimited,
	// which is the one-time create-rate limiter.
	CloseRateExceeded = 4006
	// CloseBucketLifetime is sent to both peers when a bucket exceeds its
	// total relayed-byte cap or maximum lifetime duration.
	CloseBucketLifetime = 4007
)

// Control message types sent server → client as text JSON frames.
const (
	CtrlPeerJoin  = "peer_join"
	CtrlPeerLeave = "peer_leave"
	CtrlSlot      = "slot"
	CtrlPing      = "ping"
	CtrlPong      = "pong"

	// Client → server only; consumed by the relay, never forwarded.
	CtrlPushSub   = "push_sub"
	CtrlPushUnsub = "push_unsub"
)

// MaxPushControlBytes caps a push_sub frame; larger ones are ignored.
const MaxPushControlBytes = 2048

// Control is a small JSON control message. Never contains chat content.
type Control struct {
	Type string `json:"t"`
	Slot *int   `json:"n,omitempty"`
}

// PushControl carries a browser PushSubscription. Only the endpoint is kept:
// pushes are payload-free, so the subscription's encryption keys are unused.
type PushControl struct {
	Type string `json:"t"`
	Sub  struct {
		Endpoint string `json:"endpoint"`
	} `json:"sub"`
}
