package bucket

import (
	"sync"
	"time"
)

// Close codes mirrored for tests without importing protocol cycles.
const CloseBucketFull = 4001

type Conn interface {
	RemoteAddr() string
}

// SlotAware lets a joining conn learn its seat index while the bucket lock is
// still held — that is, before the conn becomes reachable to the other seat
// through the registry. A seat assigned after Join returns would be published
// without synchronization, and a peer torn down in that window would leave
// through the wrong seat.
type SlotAware interface {
	SetSlot(slot int)
}

func seat(conn any, slot int) {
	if sa, ok := conn.(SlotAware); ok {
		sa.SetSlot(slot)
	}
}

type BufferedFrame struct {
	Data      []byte
	Binary    bool
	ExpiresAt time.Time
}

type Peer struct {
	Conn            any // *websocket-like; opaque to bucket logic
	Token           string
	DeviceSessionID string
	LastSeen        time.Time
	IP              string
	// DroppedAt is set when the peer disconnects; empty while connected.
	DroppedAt time.Time
	Connected bool
}

type Config struct {
	IdleTTL         time.Duration
	BufferTTL       time.Duration
	ReclaimTTL      time.Duration
	MaxBufferFrames int
	MaxBufferBytes  int
	Now             func() time.Time
}

type Bucket struct {
	ID        string
	Peers     [2]*Peer
	Created   time.Time
	LastSeen  time.Time
	Buffer    []BufferedFrame
	CreatorIP string

	// BytesRelayed is the cumulative number of application-data bytes
	// forwarded through this bucket over its lifetime (metadata-layer
	// counter; the relay never inspects the content of those bytes).
	BytesRelayed int64

	mu sync.Mutex
}

type Registry struct {
	cfg Config
	mu  sync.RWMutex
	m   map[string]*Bucket
}

func NewRegistry(cfg Config) *Registry {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MaxBufferFrames <= 0 {
		cfg.MaxBufferFrames = 32
	}
	if cfg.MaxBufferBytes <= 0 {
		cfg.MaxBufferBytes = 16 << 20
	}
	return &Registry{cfg: cfg, m: make(map[string]*Bucket)}
}

type JoinResult struct {
	Bucket   *Bucket
	Slot     int
	Created  bool
	Rejected bool
	Reason   string // "full" | "rate" etc — caller maps to close code
}

// Join attaches a peer to a bucket, reclaiming by token+device session when possible.
// conn is stored opaquely; Connected=true.
func (r *Registry) Join(id, token, deviceSessionID, ip string, conn any) JoinResult {
	now := r.cfg.Now()
	r.mu.Lock()
	b, exists := r.m[id]
	if !exists {
		b = &Bucket{
			ID:        id,
			Created:   now,
			LastSeen:  now,
			CreatorIP: ip,
		}
		r.m[id] = b
		r.mu.Unlock()

		b.mu.Lock()
		defer b.mu.Unlock()
		seat(conn, 0)
		b.Peers[0] = &Peer{
			Conn:            conn,
			Token:           token,
			DeviceSessionID: deviceSessionID,
			LastSeen:        now,
			IP:              ip,
			Connected:       true,
		}
		return JoinResult{Bucket: b, Slot: 0, Created: true}
	}
	r.mu.Unlock()

	b.mu.Lock()
	defer b.mu.Unlock()
	b.LastSeen = now

	// Reclaim existing slot by token (+ device session when present).
	if token != "" {
		for i, p := range b.Peers {
			if p == nil || p.Token != token {
				continue
			}
			seatHeld := peerSeatHeld(p, now, r.cfg.ReclaimTTL)

			if isThirdPartyCredentialUse(p, deviceSessionID) && seatHeld {
				return JoinResult{Rejected: true, Reason: "full", Bucket: b}
			}

			if deviceSessionMatches(p, deviceSessionID) && p.Connected {
				seat(conn, i)
				p.Conn = conn
				p.LastSeen = now
				p.DroppedAt = time.Time{}
				p.Connected = true
				p.IP = ip
				if deviceSessionID != "" {
					p.DeviceSessionID = deviceSessionID
				}
				return JoinResult{Bucket: b, Slot: i}
			}

			if deviceSessionMatches(p, deviceSessionID) && !p.DroppedAt.IsZero() && now.Sub(p.DroppedAt) <= r.cfg.ReclaimTTL {
				seat(conn, i)
				p.Conn = conn
				p.LastSeen = now
				p.DroppedAt = time.Time{}
				p.Connected = true
				p.IP = ip
				if deviceSessionID != "" {
					p.DeviceSessionID = deviceSessionID
				}
				return JoinResult{Bucket: b, Slot: i}
			}

			if !p.Connected && !peerSeatHeld(p, now, r.cfg.ReclaimTTL) {
				b.Peers[i] = nil
			}
		}
	}

	// Free slot (nil or expired disconnected).
	for i := 0; i < 2; i++ {
		p := b.Peers[i]
		if p == nil {
			seat(conn, i)
			b.Peers[i] = &Peer{
				Conn:            conn,
				Token:           token,
				DeviceSessionID: deviceSessionID,
				LastSeen:        now,
				IP:              ip,
				Connected:       true,
			}
			return JoinResult{Bucket: b, Slot: i}
		}
		if !p.Connected && !peerSeatHeld(p, now, r.cfg.ReclaimTTL) {
			seat(conn, i)
			b.Peers[i] = &Peer{
				Conn:            conn,
				Token:           token,
				DeviceSessionID: deviceSessionID,
				LastSeen:        now,
				IP:              ip,
				Connected:       true,
			}
			return JoinResult{Bucket: b, Slot: i}
		}
	}

	return JoinResult{Rejected: true, Reason: "full", Bucket: b}
}

func peerSeatHeld(p *Peer, now time.Time, reclaimTTL time.Duration) bool {
	if p.Connected {
		return true
	}
	return !p.DroppedAt.IsZero() && now.Sub(p.DroppedAt) <= reclaimTTL
}

func deviceSessionMatches(p *Peer, deviceSessionID string) bool {
	if deviceSessionID == "" && p.DeviceSessionID == "" {
		return true
	}
	// Legacy peer (no sid stored yet) — allow reclaim and adopt the new sid.
	if p.DeviceSessionID == "" && deviceSessionID != "" {
		return true
	}
	if deviceSessionID == "" || p.DeviceSessionID == "" {
		return false
	}
	return p.DeviceSessionID == deviceSessionID
}

func isThirdPartyCredentialUse(p *Peer, deviceSessionID string) bool {
	return p.DeviceSessionID != "" && deviceSessionID != "" && p.DeviceSessionID != deviceSessionID
}

// Leave marks a peer disconnected. Returns whether the bucket should be deleted
// and the other peer's conn (if connected) for peer_leave notification.
func (r *Registry) Leave(id string, slot int) (deleteBucket bool, otherConn any, otherSlot int) {
	otherSlot = -1
	r.mu.RLock()
	b := r.m[id]
	r.mu.RUnlock()
	if b == nil {
		return true, nil, -1
	}

	now := r.cfg.Now()
	b.mu.Lock()
	defer b.mu.Unlock()

	if slot < 0 || slot > 1 || b.Peers[slot] == nil {
		return r.shouldDeleteLocked(b, now), nil, -1
	}
	p := b.Peers[slot]
	p.Connected = false
	p.DroppedAt = now
	p.Conn = nil
	p.LastSeen = now
	b.LastSeen = now

	other := 1 - slot
	if b.Peers[other] != nil && b.Peers[other].Connected {
		otherConn = b.Peers[other].Conn
		otherSlot = other
	}

	if r.shouldDeleteLocked(b, now) {
		r.mu.Lock()
		delete(r.m, id)
		r.mu.Unlock()
		return true, otherConn, otherSlot
	}
	return false, otherConn, otherSlot
}

func (r *Registry) shouldDeleteLocked(b *Bucket, now time.Time) bool {
	connected := 0
	for _, p := range b.Peers {
		if p != nil && p.Connected {
			connected++
		}
	}
	if connected == 0 {
		// Both disconnected: delete immediately (or after reclaim windows expire).
		for _, p := range b.Peers {
			if p != nil && !p.DroppedAt.IsZero() && now.Sub(p.DroppedAt) <= r.cfg.ReclaimTTL {
				return false
			}
		}
		return true
	}
	return false
}

// PeerConn returns the connected peer conn for a slot, or nil.
func (b *Bucket) PeerConn(slot int) any {
	b.mu.Lock()
	defer b.mu.Unlock()
	if slot < 0 || slot > 1 || b.Peers[slot] == nil || !b.Peers[slot].Connected {
		return nil
	}
	return b.Peers[slot].Conn
}

func (b *Bucket) OtherConn(slot int) any {
	return b.PeerConn(1 - slot)
}

func (b *Bucket) ConnectedCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, p := range b.Peers {
		if p != nil && p.Connected {
			n++
		}
	}
	return n
}

// BufferOrNil buffers a frame if the other peer is offline; otherwise returns
// false so the caller should send live.
func (r *Registry) BufferIfAlone(b *Bucket, fromSlot int, data []byte, binary bool) (buffered bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	other := 1 - fromSlot
	if other < 0 || other > 1 {
		return false
	}
	op := b.Peers[other]
	if op != nil && op.Connected {
		return false
	}
	now := r.cfg.Now()
	r.pruneBufferLocked(b, now)
	for len(b.Buffer) >= r.cfg.MaxBufferFrames || bufferBytes(b)+len(data) > r.cfg.MaxBufferBytes {
		if len(b.Buffer) == 0 {
			break
		}
		b.Buffer = b.Buffer[1:]
	}
	if len(data) > r.cfg.MaxBufferBytes {
		// Single frame exceeds byte cap — do not buffer.
		return true
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	b.Buffer = append(b.Buffer, BufferedFrame{
		Data:      cp,
		Binary:    binary,
		ExpiresAt: now.Add(r.cfg.BufferTTL),
	})
	return true
}

func bufferBytes(b *Bucket) int {
	n := 0
	for _, f := range b.Buffer {
		n += len(f.Data)
	}
	return n
}

func (r *Registry) DrainBuffer(b *Bucket) []BufferedFrame {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := r.cfg.Now()
	r.pruneBufferLocked(b, now)
	out := b.Buffer
	b.Buffer = nil
	return out
}

func (r *Registry) pruneBufferLocked(b *Bucket, now time.Time) {
	if len(b.Buffer) == 0 {
		return
	}
	dst := b.Buffer[:0]
	for _, f := range b.Buffer {
		if now.Before(f.ExpiresAt) {
			dst = append(dst, f)
		}
	}
	b.Buffer = dst
}

// SweepIdle removes idle/empty buckets and returns their creator IPs for rate-limit release.
func (r *Registry) SweepIdle() []string {
	now := r.cfg.Now()
	var creators []string
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, b := range r.m {
		b.mu.Lock()
		idle := now.Sub(b.LastSeen) >= r.cfg.IdleTTL
		connected := 0
		for _, p := range b.Peers {
			if p != nil && p.Connected {
				connected++
			}
		}
		reclaimHold := false
		if connected == 0 {
			for _, p := range b.Peers {
				if p != nil && !p.DroppedAt.IsZero() && now.Sub(p.DroppedAt) <= r.cfg.ReclaimTTL {
					reclaimHold = true
					break
				}
			}
		}
		del := (connected == 0 && !reclaimHold) || (idle && connected == 0)
		creator := b.CreatorIP
		b.mu.Unlock()
		if del {
			delete(r.m, id)
			if creator != "" {
				creators = append(creators, creator)
			}
		}
	}
	return creators
}

func (r *Registry) Get(id string) *Bucket {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[id]
}

func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.m)
}

func (r *Registry) CreatorIP(id string) string {
	r.mu.RLock()
	b := r.m[id]
	r.mu.RUnlock()
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.CreatorIP
}

func (r *Registry) Delete(id string) {
	r.mu.Lock()
	delete(r.m, id)
	r.mu.Unlock()
}

func (b *Bucket) Touch() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.LastSeen = time.Now()
	for _, p := range b.Peers {
		if p != nil && p.Connected {
			p.LastSeen = b.LastSeen
		}
	}
}

// RecordBytes adds n to the bucket's lifetime relayed-byte counter and
// returns the new total. Used for the per-bucket lifetime byte cap —
// independent of Touch()/IdleTTL, which reset on any activity and so never
// bound a sustained sender.
func (b *Bucket) RecordBytes(n int) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.BytesRelayed += int64(n)
	return b.BytesRelayed
}

// Age returns how long ago the bucket was created. Used for the hard max
// bucket lifetime cap, which — unlike IdleTTL — cannot be reset by ongoing
// traffic.
func (b *Bucket) Age(now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return now.Sub(b.Created)
}
