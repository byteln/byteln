package cors_test

import (
	"testing"

	"github.com/byteln/byteln/server/internal/cors"
)

func TestOriginsFromRelayURL(t *testing.T) {
	cases := map[string]string{
		"wss://byteln.com":           "https://byteln.com",
		"wss://byteln.com/":          "https://byteln.com",
		"ws://127.0.0.1:8990":        "http://127.0.0.1",
		"ws://localhost:8990":        "http://localhost",
		"https://evil.example/x":     "https://evil.example",
	}
	for in, want := range cases {
		got := cors.OriginsFromRelayURL(in)
		if len(got) != 1 || got[0] != want {
			t.Fatalf("%s: got %v want [%s]", in, got, want)
		}
	}
	if cors.OriginsFromRelayURL("file:///etc/passwd") != nil {
		t.Fatal("file scheme should be rejected")
	}
}

func TestAllowlistEmbeddedAndExtra(t *testing.T) {
	a := cors.New("https://example.invalid/nope.json", []string{"https://chat.example.com"})
	if !a.Allow("https://byteln.com") {
		t.Fatal("embedded byteln.com")
	}
	if !a.Allow("http://localhost:5173") {
		t.Fatal("localhost any port")
	}
	if !a.Allow("https://chat.example.com") {
		t.Fatal("extra origin")
	}
	if a.Allow("https://evil.example") {
		t.Fatal("unknown should deny")
	}
	if a.CORSOrigin("https://byteln.com") != "https://byteln.com" {
		t.Fatal("cors echo")
	}
	if a.CORSOrigin("https://evil.example") != "" {
		t.Fatal("cors deny")
	}
}

func TestAllowEmptyOrigin(t *testing.T) {
	a := cors.New("", nil)
	if !a.Allow("") {
		t.Fatal("empty origin allowed for non-browser")
	}
}
