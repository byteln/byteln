package relay_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/bits"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/byteln/byteln/server/internal/config"
	"github.com/byteln/byteln/server/internal/protocol"
	"github.com/byteln/byteln/server/internal/relay"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

func startTestServerWithConfig(t *testing.T, mutate func(*config.Config)) (base string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	cfg := config.FromEnv()
	cfg.Listen = addr
	cfg.WorkerPoolSize = 32
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := relay.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.ListenAndServe(addr) }()
	time.Sleep(50 * time.Millisecond)
	return "http://" + addr, func() { srv.Shutdown() }
}

func startTestServer(t *testing.T) (base string, stop func()) {
	t.Helper()
	return startTestServerWithConfig(t, nil)
}

func TestHealth(t *testing.T) {
	base, stop := startTestServer(t)
	defer stop()
	resp, err := http.Get(base + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if len(b) == 0 {
		t.Fatal("empty body")
	}
}

// wsConn couples a dialed connection with the bytes gobwas buffered while
// reading the handshake response. ws.Dialer.Dial returns a non-nil reader
// whenever the server sent frames right after the 101 (the relay sends its
// slot control frame immediately), and reading the bare conn instead drops
// those bytes and desyncs the frame stream.
type wsConn struct {
	net.Conn
	r io.Reader
}

func (c *wsConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func wrapDialed(conn net.Conn, br *bufio.Reader) net.Conn {
	if br == nil {
		return conn
	}
	if n := br.Buffered(); n > 0 {
		return &wsConn{Conn: conn, r: io.MultiReader(io.LimitReader(br, int64(n)), conn)}
	}
	ws.PutReader(br)
	return conn
}

func dialWS(t *testing.T, httpBase, path string) net.Conn {
	t.Helper()
	u, err := url.Parse(httpBase)
	if err != nil {
		t.Fatal(err)
	}
	wsURL := "ws://" + u.Host + path
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, br, _, err := ws.DefaultDialer.Dial(ctx, wsURL)
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	return wrapDialed(conn, br)
}

// dialWSOrNil is dialWS without the t.Fatal: used from helper goroutines,
// where a rejected upgrade is an acceptable outcome.
func dialWSOrNil(httpBase, path string) (net.Conn, error) {
	u, err := url.Parse(httpBase)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, br, _, err := ws.DefaultDialer.Dial(ctx, "ws://"+u.Host+path)
	if err != nil {
		return nil, err
	}
	return wrapDialed(conn, br), nil
}

func TestRelayTwoPeers(t *testing.T) {
	base, stop := startTestServer(t)
	defer stop()

	a := dialWS(t, base, "/bucket/testbuck1?token=tokA")
	defer a.Close()
	b := dialWS(t, base, "/bucket/testbuck1?token=tokB")
	defer b.Close()

	_ = a.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, _ = wsutil.ReadServerData(a)
	_ = b.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, _ = wsutil.ReadServerData(b)

	payload := []byte{0xde, 0xad, 0xbe, 0xef}
	if err := wsutil.WriteClientMessage(a, ws.OpBinary, payload); err != nil {
		t.Fatal(err)
	}
	_ = b.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		data, op, err := wsutil.ReadServerData(b)
		if err != nil {
			t.Fatal(err)
		}
		if op == ws.OpText {
			continue
		}
		if op == ws.OpBinary {
			if string(data) != string(payload) {
				t.Fatalf("got %x want %x", data, payload)
			}
			return
		}
	}
}

func TestBucketFull(t *testing.T) {
	base, stop := startTestServer(t)
	defer stop()
	a := dialWS(t, base, "/bucket/fulltest1?token=a")
	defer a.Close()
	b := dialWS(t, base, "/bucket/fulltest1?token=b")
	defer b.Close()
	u, _ := url.Parse(base)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, _, err := ws.DefaultDialer.Dial(ctx, "ws://"+u.Host+"/bucket/fulltest1?token=c")
	if err == nil {
		_ = conn.Close()
	}
}

// readUntilClose skips text control frames and fails the test on anything
// other than a close frame, returning the close code. gobwas's
// wsutil.ReadServerData surfaces a received close frame as a
// wsutil.ClosedError rather than as (data, ws.OpClose, nil).
func readUntilClose(t *testing.T, conn net.Conn) int {
	t.Helper()
	for {
		_, op, err := wsutil.ReadServerData(conn)
		if err != nil {
			var closed wsutil.ClosedError
			if errors.As(err, &closed) {
				return int(closed.Code)
			}
			t.Fatalf("read: %v", err)
		}
		if op != ws.OpText {
			t.Fatalf("unexpected op %v before close", op)
		}
	}
}

func TestPerConnectionRateExceededCloses(t *testing.T) {
	// Byte budget far smaller than a single test frame, so the very first
	// oversized frame trips the limiter deterministically (no timing races).
	base, stop := startTestServerWithConfig(t, func(c *config.Config) {
		c.MaxBytesPerSecConn = 1
		c.MaxFramesPerSecConn = 1000
	})
	defer stop()

	a := dialWS(t, base, "/bucket/ratetest1?token=a")
	defer a.Close()

	_ = a.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, _ = wsutil.ReadServerData(a) // slot control

	payload := make([]byte, 100)
	if err := wsutil.WriteClientMessage(a, ws.OpBinary, payload); err != nil {
		t.Fatal(err)
	}

	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	if code := readUntilClose(t, a); code != protocol.CloseRateExceeded {
		t.Fatalf("got close code %d want %d", code, protocol.CloseRateExceeded)
	}
}

func TestBucketLifetimeByteCapCloses(t *testing.T) {
	base, stop := startTestServerWithConfig(t, func(c *config.Config) {
		c.MaxBytesPerSecConn = 10 << 20
		c.MaxFramesPerSecConn = 1000
		c.MaxBucketLifetimeBytes = 50
		c.MaxBucketLifetime = time.Hour
	})
	defer stop()

	a := dialWS(t, base, "/bucket/lifetest1?token=a")
	defer a.Close()

	_ = a.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, _ = wsutil.ReadServerData(a) // slot control

	payload := make([]byte, 100) // exceeds the 50-byte lifetime cap in one frame
	if err := wsutil.WriteClientMessage(a, ws.OpBinary, payload); err != nil {
		t.Fatal(err)
	}

	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	if code := readUntilClose(t, a); code != protocol.CloseBucketLifetime {
		t.Fatalf("got close code %d want %d", code, protocol.CloseBucketLifetime)
	}
}

func leadingZeroBitsForTest(h []byte) int {
	n := 0
	for _, b := range h {
		if b == 0 {
			n += 8
			continue
		}
		n += bits.LeadingZeros8(b)
		break
	}
	return n
}

// solvePow brute-forces a solution matching the server's stateless
// proof-of-work scheme, mirroring what a real client would do.
func solvePow(challenge string, difficulty int) string {
	for i := 0; ; i++ {
		sol := strconv.Itoa(i)
		h := sha256.Sum256([]byte(challenge + sol))
		if leadingZeroBitsForTest(h[:]) >= difficulty {
			return sol
		}
	}
}

func TestPowChallengeGatesUpgrade(t *testing.T) {
	base, stop := startTestServerWithConfig(t, func(c *config.Config) {
		c.PowDifficultyBits = 8 // low difficulty: fast to brute-force in a test
	})
	defer stop()

	// Without a solution, the server must not upgrade — it responds with a
	// 401 and a fresh challenge instead.
	resp, err := http.Get(base + "/bucket/powtest1?token=a")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", resp.StatusCode)
	}
	var ch struct {
		Challenge  string `json:"challenge"`
		Difficulty int    `json:"difficulty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ch); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if ch.Challenge == "" || ch.Difficulty != 8 {
		t.Fatalf("unexpected challenge response: %+v", ch)
	}

	// Solving it and retrying with the solution must succeed.
	solution := solvePow(ch.Challenge, ch.Difficulty)
	pow := url.QueryEscape(ch.Challenge + ":" + solution)
	conn := dialWS(t, base, "/bucket/powtest1?token=a&pow="+pow)
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, op, err := wsutil.ReadServerData(conn)
	if err != nil {
		t.Fatalf("expected slot control after solving pow: %v", err)
	}
	if op != ws.OpText {
		t.Fatalf("expected text control frame, got %v", op)
	}
}

func TestPowChallengeEndpointDisabledByDefault(t *testing.T) {
	base, stop := startTestServer(t)
	defer stop()

	resp, err := http.Get(base + "/pow-challenge")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	var out struct {
		Required bool `json:"required"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Required {
		t.Fatal("expected required=false when PowDifficultyBits is unset")
	}
}

// TestPowChallengeEndpoint verifies the standalone GET /pow-challenge route
// a browser client uses to fetch (and solve) a challenge *before* attempting
// the WS handshake — since a rejected WS upgrade never exposes its HTTP
// response body to page JS, the client can't discover the 401's challenge
// reactively. This must also carry a CORS header, unlike the WS-path 401,
// because it's read via a plain cross-origin fetch().
func TestPowChallengeEndpoint(t *testing.T) {
	base, stop := startTestServerWithConfig(t, func(c *config.Config) {
		c.PowDifficultyBits = 10
		c.CORSOrigins = []string{"https://example.test"}
	})
	defer stop()

	req, err := http.NewRequest(http.MethodGet, base+"/pow-challenge", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "https://example.test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://example.test" {
		t.Fatalf("missing/incorrect CORS header for cross-origin fetch: %q", got)
	}
	var out struct {
		Required   bool   `json:"required"`
		Challenge  string `json:"challenge"`
		Difficulty int    `json:"difficulty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.Required || out.Challenge == "" || out.Difficulty != 10 {
		t.Fatalf("unexpected response: %+v", out)
	}

	// The fetched challenge must actually be usable on the real WS connect.
	solution := solvePow(out.Challenge, out.Difficulty)
	pow := url.QueryEscape(out.Challenge + ":" + solution)
	conn := dialWS(t, base, "/bucket/powendpoint1?token=a&pow="+pow)
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	if _, op, err := wsutil.ReadServerData(conn); err != nil || op != ws.OpText {
		t.Fatalf("expected slot control after solving fetched challenge: op=%v err=%v", op, err)
	}
}

// drainUntilClosed reads until the connection ends. Transport-level errors
// are expected here (the server tears these connections down mid-flight);
// only a WebSocket protocol violation is a failure, since that means the
// server interleaved two writes and desynced the frame stream.
func drainUntilClosed(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := wsutil.ReadServerData(conn); err != nil {
			var proto ws.ProtocolError
			if errors.As(err, &proto) {
				t.Errorf("corrupt frame stream from server: %v", err)
			}
			return
		}
	}
}

// TestConnectDropChurn hammers the window between a peer becoming visible to
// other goroutines (its registry seat and its writer goroutine) and
// handleConn finishing the netpoll registration. The bucket byte cap trips on
// the first frame, so closeBucketPeers tears down both seats while the second
// one may still be mid-registration — the interleaving that raced on p.desc
// inside netpoll and corrupted outgoing frames. Meaningful under -race.
func TestConnectDropChurn(t *testing.T) {
	base, stop := startTestServerWithConfig(t, func(c *config.Config) {
		c.MaxBytesPerSecConn = 10 << 20
		c.MaxFramesPerSecConn = 10000
		c.MaxBucketLifetimeBytes = 64 // a single frame below exceeds this
		c.MaxBucketLifetime = time.Hour
		c.CreatePerMinPerIP = 1 << 20
		c.MaxBucketsPerIP = 1 << 20
	})
	defer stop()

	const (
		workers = 8
		rounds  = 20
	)
	payload := make([]byte, 100)

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for r := 0; r < rounds; r++ {
				bucketID := fmt.Sprintf("churn-%d-%d", w, r)
				var seats sync.WaitGroup
				for _, token := range []string{"a", "b"} {
					seats.Add(1)
					go func(token string) {
						defer seats.Done()
						conn, err := dialWSOrNil(base, "/bucket/"+bucketID+"?token="+token)
						if err != nil {
							return // rejected upgrades are fine; a hang is not
						}
						defer conn.Close()
						// Both seats send, so whichever wins the race trips
						// the cap while the other may still be registering.
						_ = wsutil.WriteClientMessage(conn, ws.OpBinary, payload)
						drainUntilClosed(t, conn)
					}(token)
				}
				seats.Wait()
			}
		}(w)
	}
	wg.Wait()
}

// TestShutdownClosesPeers pins down that Shutdown tears down live peers (and
// with them their netpoll descriptors) instead of leaking them past the
// server's lifetime.
func TestShutdownClosesPeers(t *testing.T) {
	base, stop := startTestServer(t)
	a := dialWS(t, base, "/bucket/shutdown1?token=a")
	defer a.Close()
	b := dialWS(t, base, "/bucket/shutdown1?token=b")
	defer b.Close()

	// Wait for the slot control frame so both peers are fully registered.
	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := wsutil.ReadServerData(a); err != nil {
		t.Fatalf("slot control: %v", err)
	}

	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Shutdown did not return")
	}

	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, _, err := wsutil.ReadServerData(a)
		if err == nil {
			continue // trailing control frame (e.g. peer_leave)
		}
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Fatal("peer connection still open after Shutdown")
		}
		return
	}
}

func TestPowRejectsBadSolution(t *testing.T) {
	base, stop := startTestServerWithConfig(t, func(c *config.Config) {
		c.PowDifficultyBits = 8
	})
	defer stop()

	pow := url.QueryEscape("not-a-real-challenge:0")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	u, _ := url.Parse(base)
	_, _, _, err := ws.DefaultDialer.Dial(ctx, "ws://"+u.Host+"/bucket/powtest2?token=a&pow="+pow)
	if err == nil {
		t.Fatal("expected dial to fail for an invalid pow solution")
	}
}
