package push

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVAPIDJWTVerifies(t *testing.T) {
	v, err := NewVAPID("", "mailto:test@example.com")
	if err != nil {
		t.Fatal(err)
	}
	hdr, err := v.AuthHeader("https://fcm.googleapis.com")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hdr, "vapid t=") || !strings.HasSuffix(hdr, ", k="+v.PublicKey()) {
		t.Fatalf("bad header %q", hdr)
	}
	tok := strings.TrimSuffix(strings.TrimPrefix(hdr, "vapid t="), ", k="+v.PublicKey())
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt parts %d", len(parts))
	}

	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	raw, _ := b64.DecodeString(parts[1])
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != "https://fcm.googleapis.com" || claims.Sub != "mailto:test@example.com" {
		t.Fatalf("claims %+v", claims)
	}
	if claims.Exp <= time.Now().Unix() {
		t.Fatal("exp in the past")
	}

	sig, _ := b64.DecodeString(parts[2])
	if len(sig) != 64 {
		t.Fatalf("sig len %d", len(sig))
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(&v.priv.PublicKey, sum[:], r, s) {
		t.Fatal("signature does not verify")
	}
}

func TestVAPIDLoadKeepsPublicKey(t *testing.T) {
	v, err := NewVAPID("", "mailto:x@example.com")
	if err != nil {
		t.Fatal(err)
	}
	d := make([]byte, 32)
	v.priv.D.FillBytes(d)
	v2, err := NewVAPID(b64.EncodeToString(d), "mailto:x@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if v2.PublicKey() != v.PublicKey() {
		t.Fatal("public key mismatch after reload")
	}
	if _, err := NewVAPID("not-a-key", "mailto:x@example.com"); err == nil {
		t.Fatal("expected error for bad key")
	}
}

func TestAllowedEndpoint(t *testing.T) {
	cases := map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc":                true,
		"https://updates.push.services.mozilla.com/wpush/v2/abc": true,
		"https://web.push.apple.com/QAbc":                        true,
		"https://wns2-par02p.notify.windows.com/w/?token=abc":    true,
		"http://fcm.googleapis.com/fcm/send/abc":                 false,
		"https://fcm.googleapis.com:8443/fcm/send/abc":           false,
		"https://user@fcm.googleapis.com/fcm/send/abc":           false,
		"https://evil.example.com/fcm.googleapis.com":            false,
		"https://fcm.googleapis.com.evil.example.com/x":          false,
		"https://notify.windows.com/x":                           false,
		"https://127.0.0.1/x":                                    false,
		"https://metadata.google.internal/computeMetadata/v1/":   false,
	}
	for raw, want := range cases {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := AllowedEndpoint(u); got != want {
			t.Errorf("%s: got %v want %v", raw, got, want)
		}
	}
}

func TestSenderHeadersAndGone(t *testing.T) {
	var mu sync.Mutex
	var got *http.Request
	status := http.StatusCreated
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = r.Clone(r.Context())
		st := status
		mu.Unlock()
		w.WriteHeader(st)
	}))
	defer srv.Close()

	v, err := NewVAPID("", "mailto:test@example.com")
	if err != nil {
		t.Fatal(err)
	}
	s := NewSender(v, 60*time.Second, 4)
	s.SetTransport(srv.Client(), func(*url.URL) bool { return true })

	if err := s.send(srv.URL+"/sub/1", nil); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	r := got
	mu.Unlock()
	if r.Method != http.MethodPost {
		t.Fatalf("method %s", r.Method)
	}
	if r.Header.Get("TTL") != "60" || r.Header.Get("Urgency") != "high" {
		t.Fatalf("headers %v", r.Header)
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "vapid t=") {
		t.Fatalf("auth %q", r.Header.Get("Authorization"))
	}
	if r.ContentLength > 0 {
		t.Fatalf("expected empty body, got %d", r.ContentLength)
	}

	mu.Lock()
	status = http.StatusGone
	mu.Unlock()
	gone := false
	if err := s.send(srv.URL+"/sub/1", func() { gone = true }); err != nil {
		t.Fatal(err)
	}
	if !gone {
		t.Fatal("onGone not called for 410")
	}
}

func TestValidateEndpoint(t *testing.T) {
	v, _ := NewVAPID("", "mailto:test@example.com")
	s := NewSender(v, time.Minute, 1)
	if err := s.ValidateEndpoint("https://fcm.googleapis.com/fcm/send/abc"); err != nil {
		t.Fatal(err)
	}
	if err := s.ValidateEndpoint("http://127.0.0.1:8990/health"); err == nil {
		t.Fatal("expected rejection")
	}
	if err := s.ValidateEndpoint("https://fcm.googleapis.com/" + strings.Repeat("a", MaxEndpointLen)); err == nil {
		t.Fatal("expected length rejection")
	}
}
