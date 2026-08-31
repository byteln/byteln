package relay

import (
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

	mu    sync.Mutex
	peers map[*Peer]struct{}
}

type Peer struct {
	conn      net.Conn
	desc      *netpoll.Desc
	bucket    string
	slot      int
	token     string
	ip        string
	creatorIP string
	server    *Server

	sendCh  chan outbound
	writeMu sync.Mutex
	writing atomic.Bool
	closed  atomic.Bool
}

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
	s := &Server{
		cfg: cfg,
		reg: bucket.NewRegistry(bucket.Config{
			IdleTTL:         cfg.IdleTTL,
			BufferTTL:       cfg.BufferTTL,
			ReclaimTTL:      cfg.ReclaimTTL,
			MaxBufferFrames: cfg.MaxBufferFrames,
		}),
		limit:   ratelimit.New(cfg.CreatePerMinPerIP, cfg.MaxBucketsPerIP),
		workers: NewWorker(cfg.WorkerPoolSize),
		poller:  poller,
		cors:    allow,
		done:    make(chan struct{}),
		peers:   make(map[*Peer]struct{}),
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

	p := &Peer{
		conn:   br,
		bucket: bucketID,
		token:  token,
		ip:     ip,
		server: s,
		sendCh: make(chan outbound, 64),
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
	p.slot = jr.Slot
	creatorIP := jr.Bucket.CreatorIP

	s.mu.Lock()
	s.peers[p] = struct{}{}
	s.mu.Unlock()

	s.sendControl(p, protocol.Control{Type: protocol.CtrlSlot, Slot: &p.slot})
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
		s.dropPeer(p, creatorIP)
		return
	}
	p.desc = desc
	p.creatorIP = creatorIP
	err = s.poller.Start(desc, func(ev netpoll.Event) {
		if p.closed.Load() {
			return
		}
		if ev&(netpoll.EventReadHup|netpoll.EventHup) != 0 {
			s.workers.TryGo(func() { s.dropPeer(p, p.creatorIP) })
			return
		}
		if ev&netpoll.EventRead != 0 {
			s.workers.TryGo(func() { s.readPeer(p) })
		}
	})
	if err != nil {
		s.dropPeer(p, creatorIP)
	}
}

func (s *Server) readPeer(p *Peer) {
	if p.closed.Load() {
		return
	}
	_ = p.conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	for {
		data, op, err := wsutil.ReadClientData(p.conn)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				return
			}
			if err == io.EOF || strings.Contains(err.Error(), "closed") {
				s.dropPeer(p, p.creatorIP)
				return
			}
			return
		}
		if op == ws.OpClose {
			s.dropPeer(p, p.creatorIP)
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
		b := s.reg.Get(p.bucket)
		if b == nil {
			s.dropPeer(p, p.creatorIP)
			return
		}
		b.Touch()
		if s.reg.BufferIfAlone(b, p.slot, data, op == ws.OpBinary) {
			continue
		}
		other := b.OtherConn(p.slot)
		if opPeer, ok := other.(*Peer); ok {
			opPeer.Enqueue(data, op)
			s.sendControl(p, protocol.Control{Type: protocol.CtrlPeerJoin})
		}
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

func (p *Peer) writeLoop() {
	defer p.writing.Store(false)
	for {
		select {
		case msg, ok := <-p.sendCh:
			if !ok {
				return
			}
			p.writeMu.Lock()
			err := wsutil.WriteServerMessage(p.conn, msg.opCode, msg.data)
			p.writeMu.Unlock()
			if err != nil {
				p.server.dropPeer(p, p.creatorIP)
				return
			}
		drain:
			for {
				select {
				case msg, ok := <-p.sendCh:
					if !ok {
						return
					}
					p.writeMu.Lock()
					err := wsutil.WriteServerMessage(p.conn, msg.opCode, msg.data)
					p.writeMu.Unlock()
					if err != nil {
						p.server.dropPeer(p, p.creatorIP)
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

func (s *Server) dropPeer(p *Peer, creatorIP string) {
	if !p.closed.CompareAndSwap(false, true) {
		return
	}
	if p.desc != nil {
		_ = s.poller.Stop(p.desc)
		_ = p.desc.Close()
	}
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
