package relay_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/byteln/byteln/server/internal/config"
	"github.com/byteln/byteln/server/internal/relay"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

func startTestServer(t *testing.T) (base string, stop func()) {
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
	srv, err := relay.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.ListenAndServe(addr) }()
	time.Sleep(50 * time.Millisecond)
	return "http://" + addr, func() { srv.Shutdown() }
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

func dialWS(t *testing.T, httpBase, path string) net.Conn {
	t.Helper()
	u, err := url.Parse(httpBase)
	if err != nil {
		t.Fatal(err)
	}
	wsURL := "ws://" + u.Host + path
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, _, err := ws.DefaultDialer.Dial(ctx, wsURL)
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	return conn
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
