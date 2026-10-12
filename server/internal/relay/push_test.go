package relay_test

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/byteln/byteln/server/internal/config"
	"github.com/byteln/byteln/server/internal/relay"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

func startPushTestServer(t *testing.T, stub *httptest.Server) (base string, stop func()) {
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
	cfg.PushEnabled = true
	srv, err := relay.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if stub != nil {
		srv.SetPushTransport(stub.Client(), func(u *url.URL) bool {
			return strings.HasPrefix(u.String(), stub.URL)
		})
	}
	go func() { _ = srv.ListenAndServe(addr) }()
	time.Sleep(50 * time.Millisecond)
	return "http://" + addr, func() { srv.Shutdown() }
}

func TestPushKeyEndpoint(t *testing.T) {
	base, stop := startPushTestServer(t, nil)
	defer stop()
	resp, err := http.Get(base + "/push-key")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Enabled bool   `json:"enabled"`
		Key     string `json:"key"`
	}
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode %q: %v", raw, err)
	}
	if !body.Enabled || len(body.Key) < 80 {
		t.Fatalf("unexpected body %s", raw)
	}
}

func TestPushKeyDisabled(t *testing.T) {
	base, stop := startTestServerWithConfig(t, func(c *config.Config) { c.PushEnabled = false })
	defer stop()
	resp, err := http.Get(base + "/push-key")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(raw)) != `{"enabled":false}` {
		t.Fatalf("unexpected body %s", raw)
	}
}

func TestPushSentToAbsentPeer(t *testing.T) {
	hits := make(chan *http.Request, 4)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- r.Clone(r.Context())
		w.WriteHeader(http.StatusCreated)
	}))
	defer stub.Close()

	base, stop := startPushTestServer(t, stub)
	defer stop()

	a := dialWS(t, base, "/bucket/pushbuck1?token=tokA&sid=sidA")
	b := dialWS(t, base, "/bucket/pushbuck1?token=tokB&sid=sidB")
	defer b.Close()

	sub, _ := json.Marshal(map[string]any{
		"t":   "push_sub",
		"sub": map[string]any{"endpoint": stub.URL + "/sub/a", "keys": map[string]string{"p256dh": "x", "auth": "y"}},
	})
	if err := wsutil.WriteClientMessage(a, ws.OpText, sub); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)

	// push_sub must not be forwarded to the partner.
	_ = b.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		data, op, err := wsutil.ReadServerData(b)
		if err != nil {
			break
		}
		if op == ws.OpText && strings.Contains(string(data), "push_sub") {
			t.Fatal("push_sub was forwarded to partner")
		}
	}

	_ = a.Close()
	time.Sleep(150 * time.Millisecond)

	_ = b.SetReadDeadline(time.Time{})
	if err := wsutil.WriteClientMessage(b, ws.OpBinary, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}

	select {
	case r := <-hits:
		if r.URL.Path != "/sub/a" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "vapid t=") {
			t.Fatalf("auth %q", r.Header.Get("Authorization"))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no push delivered")
	}

	// Second frame inside PushMinInterval must not push again.
	if err := wsutil.WriteClientMessage(b, ws.OpBinary, []byte{4, 5, 6}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-hits:
		t.Fatal("push not rate limited")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestPushSubRejectsDisallowedEndpoint(t *testing.T) {
	hits := make(chan struct{}, 4)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits <- struct{}{}
		w.WriteHeader(http.StatusCreated)
	}))
	defer stub.Close()

	// No transport override: the production allowlist rejects the stub URL.
	base, stop := startPushTestServer(t, nil)
	defer stop()

	a := dialWS(t, base, "/bucket/pushbuck2?token=tokA&sid=sidA")
	b := dialWS(t, base, "/bucket/pushbuck2?token=tokB&sid=sidB")
	defer b.Close()

	sub, _ := json.Marshal(map[string]any{"t": "push_sub", "sub": map[string]string{"endpoint": stub.URL + "/x"}})
	_ = wsutil.WriteClientMessage(a, ws.OpText, sub)
	time.Sleep(100 * time.Millisecond)
	_ = a.Close()
	time.Sleep(150 * time.Millisecond)
	_ = wsutil.WriteClientMessage(b, ws.OpBinary, []byte{1})

	select {
	case <-hits:
		t.Fatal("push sent to disallowed endpoint")
	case <-time.After(500 * time.Millisecond):
	}
}
