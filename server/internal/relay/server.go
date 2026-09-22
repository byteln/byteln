package relay

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/byteln/byteln/server/internal/bucket"
	"github.com/byteln/byteln/server/internal/config"
	"github.com/byteln/byteln/server/internal/cors"
	"github.com/byteln/byteln/server/internal/protocol"
	"github.com/byteln/byteln/server/internal/ratelimit"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	"github.com/mailru/easygo/netpoll"
)

type Server struct {
	cfg      config.Config
	reg      *bucket.Registry
	limit    *ratelimit.Limiter
	workers  *Worker
	poller   netpoll.Poller
	cors     *cors.Allowlist
	ln       net.Listener
	shutdown atomic.Bool
	done     chan struct{}
	wg       sync.WaitGroup

	// powSecret signs stateless proof-of-work challenges (see pow.go).
	// Generated once at startup; never persisted, never derived from any
	// client-supplied or room-related value.
	powSecret []byte

	mu    sync.Mutex
	peers map[*Peer]struct{}
}

type Peer struct {
	conn   net.Conn
	bucket string
	token  string
	ip     string
	server *Server

	// slot is assigned by the registry while it holds the bucket lock (see
	// bucket.SlotAware), so it is set before this peer is reachable to the
	// other seat and needs no further synchronization.
	slot int

	// descMu guards desc for its whole lifetime. The peer is reachable by
	// other goroutines (registry, writeLoop) before handleConn registers it
	// with the poller, so poller.Start must not overlap a concurrent
	// dropPeer's poller.Stop/desc.Close — both touch the same *os.File, and
	// closing first would leave a dead peer's callback bound to an fd
	// number the kernel can hand to the next connection.
	descMu sync.Mutex
	desc   *netpoll.Desc

	// Per-connection throughput limiter + traffic-shape signal (metadata
	// layer only — never inspects frame content). See throttle.go.
	byteLimiter  *tokenBucket
	frameLimiter *tokenBucket
	shape        shapeStats

	sendCh    chan outbound
	writeMu   sync.Mutex
	writing   atomic.Bool
	reading   atomic.Bool
	readAgain atomic.Bool
	closed    atomic.Bool
}

// SetSlot implements bucket.SlotAware.
func (p *Peer) SetSlot(slot int) { p.slot = slot }

type outbound struct {
	data   []byte
	opCode ws.OpCode
}

func New(cfg config.Config) (*Server, error) {
	poller, err := netpoll.New(nil)
	if err != nil {
		return nil, fmt.Errorf("netpoll: %w", err)
	}
	allow := cors.New(cfg.DirectoryURL, cfg.CORSOrigins)
	powSecret := make([]byte, 32)
	if _, err := rand.Read(powSecret); err != nil {
		return nil, fmt.Errorf("pow secret: %w", err)
	}
	s := &Server{
		cfg: cfg,
		reg: bucket.NewRegistry(bucket.Config{
			IdleTTL:         cfg.IdleTTL,
			BufferTTL:       cfg.BufferTTL,
			ReclaimTTL:      cfg.ReclaimTTL,
			MaxBufferFrames: cfg.MaxBufferFrames,
			MaxBufferBytes:  cfg.MaxBufferBytes,
		}),
		limit:     ratelimit.New(cfg.CreatePerMinPerIP, cfg.MaxBucketsPerIP),
		workers:   NewWorker(cfg.WorkerPoolSize),
		poller:    poller,
		cors:      allow,
		done:      make(chan struct{}),
		peers:     make(map[*Peer]struct{}),
		powSecret: powSecret,
	}
	// Async first-run refresh — start with embedded allowlist immediately.
	go func() {
		if err := allow.Refresh(); err != nil {
			log.Printf("cors: initial directory fetch failed (using embedded allowlist): %v", err)
		}
	}()
	return s, nil
}

func (s *Server) ListenAndServe(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln

	s.wg.Add(2)
	go s.sweepLoop()
	go s.corsRefreshLoop()

	log.Printf("bytelnd listening on %s", addr)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if s.shutdown.Load() {
				return nil
			}
			log.Printf("accept: %v", err)
			continue
		}
		if !s.workers.TryGo(func() { s.handleConn(conn) }) {
			_ = conn.Close()
		}
	}
}

func (s *Server) corsRefreshLoop() {
	defer s.wg.Done()
	interval := s.cfg.CORSRefresh
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			if err := s.cors.Refresh(); err != nil {
				log.Printf("cors: refresh failed (keeping previous): %v", err)
			}
		}
	}
}

func (s *Server) Shutdown() {
	s.shutdown.Store(true)
	if s.ln != nil {
		_ = s.ln.Close()
	}
	select {
	case <-s.done:
	default:
		close(s.done)
	}

	// Tear down live peers before the poller: each dropPeer deregisters and
	// closes its desc, so no dup'd fd or epoll registration outlives the
	// server. dropPeer takes s.mu itself, so snapshot the set first.
	s.mu.Lock()
	peers := make([]*Peer, 0, len(s.peers))
	for p := range s.peers {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	for _, p := range peers {
		s.dropPeer(p)
	}
	if c, ok := s.poller.(interface{ Close() error }); ok {
		_ = c.Close()
	}

	s.wg.Wait()
}

func (s *Server) sweepLoop() {
	defer s.wg.Done()
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			for _, ip := range s.reg.SweepIdle() {
				s.limit.ReleaseBucket(ip)
			}
		}
	}
}

func (s *Server) handleConn(conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	br := newBufConn(conn)
	raw, reqLine, headers, err := readHTTPHeaders(br)
	if err != nil {
		_ = conn.Close()
		return
	}
	method, path, _ := parseReqLine(reqLine)
	_ = conn.SetDeadline(time.Time{})
	origin := headerGet(headers, "Origin")

	if method == "OPTIONS" && (path == "/health" || path == "/health/") {
		writeCORSPreflight(br, s.cors.CORSOrigin(origin))
		_ = conn.Close()
		return
	}

	if method == "GET" && (path == "/health" || path == "/health/") {
		writeHealth(br, s.cors.CORSOrigin(origin))
		_ = conn.Close()
		return
	}

	// Plain HTTP (not a WS upgrade) endpoint so a browser client can fetch a
	// proof-of-work challenge — and, cheaply, learn that none is required —
	// before ever attempting the WS handshake. The WS path below remains the
	// authoritative check; this just lets a real client avoid burning a
	// connect attempt (and its create-rate budget) discovering it needs one.
	if method == "OPTIONS" && (path == "/pow-challenge" || path == "/pow-challenge/") {
		writeCORSPreflight(br, s.cors.CORSOrigin(origin))
		_ = conn.Close()
		return
	}
	if method == "GET" && (path == "/pow-challenge" || path == "/pow-challenge/") {
		s.writePowChallengeResponse(br, s.cors.CORSOrigin(origin))
		_ = conn.Close()
		return
	}

	if method != "GET" || !strings.HasPrefix(path, "/bucket/") {
		writeHTTP(br, 404, "text/plain", "not found\n", "")
		_ = conn.Close()
		return
	}

	u, err := url.ParseRequestURI(path)
	if err != nil {
		writeHTTP(br, 400, "text/plain", "bad path\n", "")
		_ = conn.Close()
		return
	}
	bucketID := strings.TrimPrefix(u.Path, "/bucket/")
	bucketID = strings.Trim(bucketID, "/")
	if !validBucketID(bucketID) {
		writeHTTP(br, 400, "text/plain", "bad bucket id\n", "")
		_ = conn.Close()
		return
	}

	if s.cfg.CheckWSOrigin && origin != "" && !s.cors.Allow(origin) {
		writeHTTP(br, 403, "text/plain", "origin not allowed\n", "")
		_ = conn.Close()
		return
	}

	// Optional proof-of-work gate (disabled by default via difficulty=0).
	// Applies to both bucket creation and join attempts, ahead of the
	// create-rate limiter, so a failed/missing solve doesn't consume the
	// caller's create budget. Stateless: no per-challenge storage.
	if s.cfg.PowDifficultyBits > 0 {
		pow := u.Query().Get("pow")
		if pow == "" || !s.verifyPow(pow) {
			challenge := s.issuePowChallenge()
			body := fmt.Sprintf(`{"required":true,"challenge":%q,"difficulty":%d}`, challenge, s.cfg.PowDifficultyBits)
			writeHTTP(br, 401, "application/json", body+"\n", s.cors.CORSOrigin(origin))
			_ = conn.Close()
			return
		}
	}

	token := u.Query().Get("token")
	if token == "" {
		token = headerGet(headers, "X-Byteln-Token")
	}
	deviceSessionID := u.Query().Get("sid")
	ip := clientIP(conn, headers)

	exists := s.reg.Get(bucketID) != nil
	if !exists {
		if !s.limit.AllowCreate(ip) {
			writeHTTP(br, 429, "text/plain", "rate limited\n", "")
			_ = conn.Close()
			return
		}
		if !s.limit.TryAcquireBucket(ip) {
			writeHTTP(br, 429, "text/plain", "too many buckets\n", "")
			_ = conn.Close()
			return
		}
	}

	// Replay the HTTP request so gobwas can complete the upgrade.
	replayRequest(br, raw)
	upgrader := ws.Upgrader{}
	_, err = upgrader.Upgrade(br)
	if err != nil {
		if !exists {
			s.limit.ReleaseBucket(ip)
		}
		_ = conn.Close()
		return
	}

	now := time.Now()
	p := &Peer{
		conn:         br,
		bucket:       bucketID,
		token:        token,
		ip:           ip,
		server:       s,
		sendCh:       make(chan outbound, 64),
		byteLimiter:  newTokenBucket(float64(s.cfg.MaxBytesPerSecConn)*2, now),
		frameLimiter: newTokenBucket(float64(s.cfg.MaxFramesPerSecConn)*2, now),
	}

	jr := s.reg.Join(bucketID, token, deviceSessionID, ip, p)
	if jr.Rejected {
		if !exists {
			s.limit.ReleaseBucket(ip)
		}
		_ = wsutil.WriteServerMessage(br, ws.OpClose, ws.NewCloseFrameBody(protocol.CloseBucketFull, "bucket full"))
		_ = conn.Close()
		return
	}
	slot := jr.Slot // p.slot was set by Join, under the bucket lock

	s.mu.Lock()
	s.peers[p] = struct{}{}
	s.mu.Unlock()

	s.sendControl(p, protocol.Control{Type: protocol.CtrlSlot, Slot: &slot})
	s.notifyPeerPresence(jr.Bucket)

	for _, f := range s.reg.DrainBuffer(jr.Bucket) {
		op := ws.OpBinary
		if !f.Binary {
			op = ws.OpText
		}
		p.Enqueue(f.Data, op)
	}

	// Register the underlying TCP conn (filer); *bufConn does not expose File().
	desc, err := netpoll.HandleRead(conn)
	if err != nil {
		log.Printf("netpoll handle: %v", err)
		s.dropPeer(p)
		return
	}

	p.descMu.Lock()
	if p.closed.Load() {
		// Dropped while we were creating the desc — dropPeer has already run
		// its teardown (or found no desc to tear down), so close ours here
		// rather than registering a descriptor nobody will deregister.
		p.descMu.Unlock()
		_ = desc.Close()
		return
	}
	p.desc = desc
	err = s.poller.Start(desc, func(ev netpoll.Event) {
		if p.closed.Load() {
			return
		}
		if ev&(netpoll.EventReadHup|netpoll.EventHup) != 0 {
			s.workers.TryGo(func() { s.dropPeer(p) })
			return
		}
		if ev&netpoll.EventRead != 0 {
			s.workers.TryGo(func() { s.readPeer(p) })
		}
	})
	p.descMu.Unlock()
	if err != nil {
		s.dropPeer(p)
	}
}

func (s *Server) readPeer(p *Peer) {
	if p.closed.Load() {
		return
	}
	// bufio.Reader on the conn is not concurrency-safe. Edge-triggered
	// EventRead can fire again while a large frame (e.g. image) is still
	// being drained — serialize and re-run if a poll was skipped.
	if !p.reading.CompareAndSwap(false, true) {
		p.readAgain.Store(true)
		return
	}
	defer p.reading.Store(false)

	for {
		if p.closed.Load() {
			return
		}
		p.readAgain.Store(false)

		idle := false
		for {
			data, op, err := s.readClientFrame(p)
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					idle = true
					break
				}
				if err == io.EOF || strings.Contains(err.Error(), "closed") {
					s.dropPeer(p)
					return
				}
				return
			}
			if op == ws.OpClose {
				s.dropPeer(p)
				return
			}
			if op == ws.OpPing {
				if b := s.reg.Get(p.bucket); b != nil {
					b.Touch()
				}
				p.Enqueue(data, ws.OpPong)
				continue
			}
			if op == ws.OpText {
				var ctrl protocol.Control
				if json.Unmarshal(data, &ctrl) == nil && ctrl.Type == protocol.CtrlPing {
					if b := s.reg.Get(p.bucket); b != nil {
						b.Touch()
					}
					s.sendControl(p, protocol.Control{Type: protocol.CtrlPong})
					continue
				}
			}
			if op != ws.OpBinary && op != ws.OpText {
				continue
			}
			if len(data) > s.cfg.MaxFrameBytes {
				continue
			}

			// Per-connection throughput limiter + traffic-shape signal.
			// Metadata-layer only: rate/size/timing, never frame content.
			// A bot-like shape (sustained, low-variance, large frames —
			// the chunked-file-transfer signature) tightens the effective
			// rate rather than blocking outright; the throughput cap below
			// is what actually closes the connection.
			now := time.Now()
			botLike := p.shape.observe(now, len(data))
			byteRate := float64(s.cfg.MaxBytesPerSecConn)
			frameRate := float64(s.cfg.MaxFramesPerSecConn)
			if botLike {
				byteRate /= 2
				frameRate /= 2
			}
			if !p.byteLimiter.allow(now, float64(len(data)), byteRate) ||
				!p.frameLimiter.allow(now, 1, frameRate) {
				s.closePeerWithCode(p, protocol.CloseRateExceeded, "rate exceeded")
				return
			}

			b := s.reg.Get(p.bucket)
			if b == nil {
				s.dropPeer(p)
				return
			}
			b.Touch()

			// Per-bucket lifetime caps: cumulative bytes and hard duration.
			// Touch() above resets the idle timer on every frame, so a
			// sustained sender would otherwise never hit IdleTTL — these
			// caps are independent of idle detection.
			if s.cfg.MaxBucketLifetimeBytes > 0 && b.RecordBytes(len(data)) > s.cfg.MaxBucketLifetimeBytes {
				s.closeBucketPeers(b, protocol.CloseBucketLifetime, "bucket byte cap exceeded")
				return
			}
			if s.cfg.MaxBucketLifetime > 0 && b.Age(now) > s.cfg.MaxBucketLifetime {
				s.closeBucketPeers(b, protocol.CloseBucketLifetime, "bucket lifetime exceeded")
				return
			}

			if s.reg.BufferIfAlone(b, p.slot, data, op == ws.OpBinary) {
				continue
			}
			other := b.OtherConn(p.slot)
			if opPeer, ok := other.(*Peer); ok {
				opPeer.Enqueue(data, op)
				s.sendControl(p, protocol.Control{Type: protocol.CtrlPeerJoin})
			}
		}

		if !idle || !p.readAgain.Load() {
			return
		}
	}
}

// readClientFrame reads one application data frame. Short idle deadline for
// the header; longer deadline once a payload is in flight (images up to MaxFrameBytes).
func (s *Server) readClientFrame(p *Peer) ([]byte, ws.OpCode, error) {
	conn := p.conn
	_ = conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	controlHandler := wsutil.ControlFrameHandler(peerWriter{p}, ws.StateServerSide)
	rd := wsutil.Reader{
		Source:         conn,
		State:          ws.StateServerSide,
		CheckUTF8:      true,
		OnIntermediate: controlHandler,
	}
	for {
		hdr, err := rd.NextFrame()
		if err != nil {
			return nil, 0, err
		}
		if hdr.OpCode.IsControl() {
			if err := controlHandler(hdr, &rd); err != nil {
				return nil, 0, err
			}
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		payload, err := io.ReadAll(&rd)
		return payload, hdr.OpCode, err
	}
}

func (s *Server) notifyPeerPresence(b *bucket.Bucket) {
	if b.ConnectedCount() < 2 {
		return
	}
	for slot := 0; slot < 2; slot++ {
		if conn := b.PeerConn(slot); conn != nil {
			if rp, ok := conn.(*Peer); ok {
				s.sendControl(rp, protocol.Control{Type: protocol.CtrlPeerJoin})
			}
		}
	}
}

func (p *Peer) Enqueue(data []byte, op ws.OpCode) {
	if p.closed.Load() {
		return
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	select {
	case p.sendCh <- outbound{data: cp, opCode: op}:
		p.ensureWriter()
	default:
		// Drop under extreme backpressure rather than blocking the relay.
	}
}

func (p *Peer) ensureWriter() {
	if p.writing.Swap(true) {
		return
	}
	go p.writeLoop()
}

// writeFrame writes one server frame. Every server-to-client frame goes
// through here (or through peerWriter) so that a close frame emitted from a
// read/limiter path can never interleave with the writer goroutine's bytes
// and desync the client's frame stream.
func (p *Peer) writeFrame(op ws.OpCode, data []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return wsutil.WriteServerMessage(p.conn, op, data)
}

// peerWriter lets gobwas emit its own control-frame replies (pong, close
// echo) without bypassing writeMu. ControlHandler builds each control frame
// in one buffered Write, so locking per Write keeps the frame atomic.
type peerWriter struct{ p *Peer }

func (w peerWriter) Write(b []byte) (int, error) {
	w.p.writeMu.Lock()
	defer w.p.writeMu.Unlock()
	return w.p.conn.Write(b)
}

func (p *Peer) writeLoop() {
	defer p.writing.Store(false)
	for {
		select {
		case msg, ok := <-p.sendCh:
			if !ok {
				return
			}
			if err := p.writeFrame(msg.opCode, msg.data); err != nil {
				p.server.dropPeer(p)
				return
			}
		drain:
			for {
				select {
				case msg, ok := <-p.sendCh:
					if !ok {
						return
					}
					if err := p.writeFrame(msg.opCode, msg.data); err != nil {
						p.server.dropPeer(p)
						return
					}
				default:
					break drain
				}
			}
			if len(p.sendCh) == 0 {
				return
			}
		default:
			return
		}
	}
}

func (s *Server) sendControl(p *Peer, c protocol.Control) {
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	p.Enqueue(b, ws.OpText)
}

// closePeerWithCode sends a WS close frame with a specific application code
// (so an honest client gets a clear signal instead of frames silently
// vanishing) and then tears the connection down.
func (s *Server) closePeerWithCode(p *Peer, code int, reason string) {
	_ = p.writeFrame(ws.OpClose, ws.NewCloseFrameBody(ws.StatusCode(code), reason))
	s.dropPeer(p)
}

// closeBucketPeers closes both seats of a bucket with the given code, used
// for bucket-wide limits (lifetime bytes/duration) rather than a single
// connection's rate.
func (s *Server) closeBucketPeers(b *bucket.Bucket, code int, reason string) {
	for slot := 0; slot < 2; slot++ {
		if conn := b.PeerConn(slot); conn != nil {
			if rp, ok := conn.(*Peer); ok {
				s.closePeerWithCode(rp, code, reason)
			}
		}
	}
}

func (s *Server) dropPeer(p *Peer) {
	if !p.closed.CompareAndSwap(false, true) {
		return
	}

	// Read the creator IP while the bucket is still around. If SweepIdle got
	// there first it already released the IP, and this returns "" so we don't
	// release it twice.
	creatorIP := s.reg.CreatorIP(p.bucket)

	p.descMu.Lock()
	if p.desc != nil {
		_ = s.poller.Stop(p.desc)
		_ = p.desc.Close()
		p.desc = nil
	}
	p.descMu.Unlock()
	_ = p.conn.Close()

	s.mu.Lock()
	delete(s.peers, p)
	s.mu.Unlock()

	del, other, _ := s.reg.Leave(p.bucket, p.slot)
	if op, ok := other.(*Peer); ok {
		s.sendControl(op, protocol.Control{Type: protocol.CtrlPeerLeave})
	}
	if del && creatorIP != "" {
		s.limit.ReleaseBucket(creatorIP)
	}
}

func validBucketID(id string) bool {
	if len(id) < 4 || len(id) > 32 {
		return false
	}
	for _, c := range id {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}

func clientIP(conn net.Conn, headers map[string]string) string {
	if xff := headerGet(headers, "X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return conn.RemoteAddr().String()
	}
	return host
}

func headerGet(h map[string]string, k string) string {
	return h[http.CanonicalHeaderKey(k)]
}

func writeHealth(w io.Writer, allowOrigin string) {
	body := `{"ok":true,"service":"bytelnd"}`
	writeHTTP(w, 200, "application/json", body+"\n", allowOrigin)
}

// writePowChallengeResponse answers GET /pow-challenge. Stateless and side
// effect free: no rate-limit budget or bucket registry lookup touched, so a
// client can call this on every connect attempt (or reconnect) without cost.
func (s *Server) writePowChallengeResponse(w io.Writer, allowOrigin string) {
	if s.cfg.PowDifficultyBits <= 0 {
		writeHTTP(w, 200, "application/json", `{"required":false}`+"\n", allowOrigin)
		return
	}
	challenge := s.issuePowChallenge()
	body := fmt.Sprintf(`{"required":true,"challenge":%q,"difficulty":%d}`, challenge, s.cfg.PowDifficultyBits)
	writeHTTP(w, 200, "application/json", body+"\n", allowOrigin)
}

func writeCORSPreflight(w io.Writer, allowOrigin string) {
	if allowOrigin == "" {
		_, _ = fmt.Fprintf(w, "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 16\r\nConnection: close\r\n\r\norigin forbidden\n")
		return
	}
	_, _ = fmt.Fprintf(w, "HTTP/1.1 204 No Content\r\n"+
		"Access-Control-Allow-Origin: %s\r\n"+
		"Vary: Origin\r\n"+
		"Access-Control-Allow-Methods: GET, OPTIONS\r\n"+
		"Access-Control-Allow-Headers: Content-Type, X-Byteln-Token\r\n"+
		"Access-Control-Max-Age: 86400\r\n"+
		"Content-Length: 0\r\n"+
		"Connection: close\r\n\r\n", allowOrigin)
}

func writeHTTP(w io.Writer, code int, ctype, body, allowOrigin string) {
	status := http.StatusText(code)
	corsHdr := ""
	if allowOrigin != "" {
		corsHdr = fmt.Sprintf("Access-Control-Allow-Origin: %s\r\nVary: Origin\r\n", allowOrigin)
	}
	_, _ = fmt.Fprintf(w, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\n%sContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		code, status, ctype, corsHdr, len(body), body)
}
