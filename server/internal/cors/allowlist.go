package cors

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
	"time"
)

const (
	DefaultDirectoryURL = "https://raw.githubusercontent.com/byteln/byteln/main/directory/servers.json"
	maxDirectoryBytes   = 256 << 10 // 256 KiB
	maxEntries          = 500
)

// Embedded bootstrap origins used before (or if) the directory fetch fails.
var embeddedOrigins = []string{
	"https://byteln.dev",
	"https://www.byteln.dev",
	"http://localhost",
	"http://127.0.0.1",
	"http://[::1]",
}

type directoryEntry struct {
	URL     string   `json:"url"`
	Clients []string `json:"clients"`
}

// Allowlist is an in-memory set of permitted browser Origins.
type Allowlist struct {
	mu sync.RWMutex

	exact   map[string]struct{} // full origins e.g. https://byteln.dev:443 uncommon — usually no port
	hosts   map[string]struct{} // hostnames allowed with http/https any port (localhost)
	extra   []string            // from BYTELN_CORS_ORIGINS
	dirURL  string
	client  *http.Client
	lastErr string
	count   int
}

func New(dirURL string, extraOrigins []string) *Allowlist {
	if dirURL == "" {
		dirURL = DefaultDirectoryURL
	}
	a := &Allowlist{
		exact:  make(map[string]struct{}),
		hosts:  make(map[string]struct{}),
		extra:  append([]string(nil), extraOrigins...),
		dirURL: dirURL,
		client: &http.Client{Timeout: 8 * time.Second},
	}
	a.resetToEmbedded()
	a.applyExtras()
	return a
}

func (a *Allowlist) resetToEmbedded() {
	a.exact = make(map[string]struct{})
	a.hosts = make(map[string]struct{})
	for _, o := range embeddedOrigins {
		a.addOriginLocked(o)
	}
	a.count = len(a.exact) + len(a.hosts)
}

func (a *Allowlist) applyExtras() {
	for _, o := range a.extra {
		a.addOriginLocked(strings.TrimSpace(o))
	}
	a.count = len(a.exact) + len(a.hosts)
}

// Refresh fetches servers.json and rebuilds the allowlist (keeps previous on failure).
func (a *Allowlist) Refresh() error {
	entries, err := a.fetchDirectory()
	if err != nil {
		a.mu.Lock()
		a.lastErr = err.Error()
		a.mu.Unlock()
		return err
	}

	nextExact := make(map[string]struct{})
	nextHosts := make(map[string]struct{})
	tmp := &Allowlist{exact: nextExact, hosts: nextHosts}

	for _, o := range embeddedOrigins {
		tmp.addOriginLocked(o)
	}
	for _, e := range entries {
		for _, o := range OriginsFromRelayURL(e.URL) {
			tmp.addOriginLocked(o)
		}
		for _, c := range e.Clients {
			tmp.addOriginLocked(c)
		}
	}
	for _, o := range a.extra {
		tmp.addOriginLocked(strings.TrimSpace(o))
	}

	a.mu.Lock()
	a.exact = nextExact
	a.hosts = nextHosts
	a.count = len(a.exact) + len(a.hosts)
	a.lastErr = ""
	n := a.count
	a.mu.Unlock()
	log.Printf("cors: allowlist refreshed (%d entries) from %s", n, a.dirURL)
	return nil
}

func (a *Allowlist) fetchDirectory() ([]directoryEntry, error) {
	u, err := url.Parse(a.dirURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("invalid directory url")
	}
	// Prefer https for remote hosts.
	if u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Scheme != "https" {
		return nil, fmt.Errorf("directory url must be https")
	}

	req, err := http.NewRequest(http.MethodGet, a.dirURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "bytelnd-cors/1")

	res, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("directory http %d", res.StatusCode)
	}

	limited := io.LimitReader(res.Body, maxDirectoryBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(raw) > maxDirectoryBytes {
		return nil, fmt.Errorf("directory too large")
	}

	var entries []directoryEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("directory json: %w", err)
	}
	if len(entries) > maxEntries {
		return nil, fmt.Errorf("too many directory entries")
	}
	return entries, nil
}

func (a *Allowlist) addOriginLocked(raw string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || !validHost(host) {
		return
	}

	// Loopback: allow any port for local Vite/dev.
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		a.hosts[host] = struct{}{}
		return
	}

	origin := scheme + "://" + host
	if u.Port() != "" && u.Port() != defaultPort(scheme) {
		origin += ":" + u.Port()
	}
	a.exact[origin] = struct{}{}
}

func defaultPort(scheme string) string {
	if scheme == "https" {
		return "443"
	}
	return "80"
}

func validHost(host string) bool {
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	// Reject weird schemes leftovers / spaces.
	if strings.ContainsAny(host, " /\\<>\"'") {
		return false
	}
	// IP or DNS-ish
	if ip := net.ParseIP(host); ip != nil {
		return true
	}
	if !strings.Contains(host, ".") {
		return false
	}
	for _, p := range strings.Split(host, ".") {
		if p == "" || len(p) > 63 {
			return false
		}
	}
	return true
}

// OriginsFromRelayURL maps wss://host → https://host (and ws → http for loopback only).
func OriginsFromRelayURL(relay string) []string {
	relay = strings.TrimSpace(relay)
	if relay == "" {
		return nil
	}
	u, err := url.Parse(relay)
	if err != nil || u.Host == "" {
		return nil
	}
	host := strings.ToLower(u.Hostname())
	if !validHost(host) {
		return nil
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "wss", "https":
		return []string{"https://" + host}
	case "ws", "http":
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return []string{"http://" + host}
		}
		// Non-local insecure relays: still advertise https client origin assumption.
		return []string{"https://" + host}
	default:
		return nil
	}
}

// Allow reports whether a request Origin is permitted.
// Empty origin (non-browser) is allowed for WS clients; for CORS responses use Match.
func (a *Allowlist) Allow(origin string) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	scheme := strings.ToLower(u.Scheme)

	a.mu.RLock()
	defer a.mu.RUnlock()

	if _, ok := a.hosts[host]; ok && (scheme == "http" || scheme == "https") {
		return true
	}
	norm := scheme + "://" + host
	if u.Port() != "" && u.Port() != defaultPort(scheme) {
		norm += ":" + u.Port()
	}
	_, ok := a.exact[norm]
	return ok
}

// CORSOrigin returns the Origin to echo, or empty if not allowed.
func (a *Allowlist) CORSOrigin(origin string) string {
	if origin == "" || !a.Allow(origin) {
		return ""
	}
	return origin
}

func (a *Allowlist) Stats() (count int, lastErr string) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.count, a.lastErr
}

// ParseOriginsCSV splits BYTELN_CORS_ORIGINS.
func ParseOriginsCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
