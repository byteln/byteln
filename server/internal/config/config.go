package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen            string
	IdleTTL           time.Duration
	BufferTTL         time.Duration
	ReclaimTTL        time.Duration
	MaxBucketsPerIP   int
	CreatePerMinPerIP int
	WorkerPoolSize    int
	AcceptQueueSize   int
	MaxFrameBytes     int
	MaxBufferFrames   int

	DirectoryURL   string
	CORSOrigins    []string
	CORSRefresh    time.Duration
	CheckWSOrigin  bool
}

func FromEnv() Config {
	return Config{
		Listen:            listenAddr(),
		IdleTTL:           durationEnv("BYTELN_IDLE_TTL", 10*time.Minute),
		BufferTTL:         durationEnv("BYTELN_BUFFER_TTL", 60*time.Second),
		ReclaimTTL:        durationEnv("BYTELN_RECLAIM_TTL", 30*time.Second),
		MaxBucketsPerIP:   intEnv("BYTELN_MAX_BUCKETS_PER_IP", 32),
		CreatePerMinPerIP: intEnv("BYTELN_CREATE_PER_MIN_IP", 10),
		WorkerPoolSize:    intEnv("BYTELN_WORKER_POOL", 256),
		AcceptQueueSize:   intEnv("BYTELN_ACCEPT_QUEUE", 1024),
		MaxFrameBytes:     intEnv("BYTELN_MAX_FRAME_BYTES", 64*1024),
		MaxBufferFrames:   intEnv("BYTELN_MAX_BUFFER_FRAMES", 32),
		DirectoryURL:      getenv("BYTELN_DIRECTORY_URL", "https://raw.githubusercontent.com/byteln/byteln/main/directory/servers.json"),
		CORSOrigins:       splitCSV(os.Getenv("BYTELN_CORS_ORIGINS")),
		CORSRefresh:       durationEnv("BYTELN_CORS_REFRESH", 6*time.Hour),
		CheckWSOrigin:     boolEnv("BYTELN_CHECK_WS_ORIGIN", true),
	}
}

func splitCSV(s string) []string {
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

func boolEnv(k string, def bool) bool {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

// listenAddr resolves BYTELN_LISTEN, else BYTELN_PORT, else :8990.
func listenAddr() string {
	if v := os.Getenv("BYTELN_LISTEN"); v != "" {
		return v
	}
	if p := os.Getenv("BYTELN_PORT"); p != "" {
		if p[0] == ':' {
			return p
		}
		return ":" + p
	}
	return ":8990"
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func intEnv(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func durationEnv(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
