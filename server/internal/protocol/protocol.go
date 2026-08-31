package protocol

// WebSocket close codes (application range).
const (
	CloseBucketFull   = 4001
	CloseBadBucketID  = 4002
	CloseRateLimited  = 4003
	CloseIdleTimeout  = 4004
	CloseServerShutdown = 4005
)

// Control message types sent server → client as text JSON frames.
const (
	CtrlPeerJoin  = "peer_join"
	CtrlPeerLeave = "peer_leave"
	CtrlSlot      = "slot"
	CtrlPing      = "ping"
	CtrlPong      = "pong"
)

// Control is a small JSON control message. Never contains chat content.
type Control struct {
	Type string `json:"t"`
	Slot *int   `json:"n,omitempty"`
}
