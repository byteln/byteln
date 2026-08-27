package ratelimit

import (
	"sync"
	"time"
)

// Limiter is a simple per-key token bucket (fixed window) for create rates
// and a concurrent counter for bucket ownership.
type Limiter struct {
	mu sync.Mutex

	createWindow time.Duration
	createLimit  int
	creates      map[string]*window

	maxBuckets int
	buckets    map[string]int // ip -> active bucket count
}

type window struct {
	start time.Time
	count int
}

func New(createPerMin, maxBuckets int) *Limiter {
	return &Limiter{
		createWindow: time.Minute,
		createLimit:  createPerMin,
		creates:      make(map[string]*window),
		maxBuckets:   maxBuckets,
		buckets:      make(map[string]int),
	}
}

func (l *Limiter) AllowCreate(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.creates[ip]
	if !ok || now.Sub(w.start) >= l.createWindow {
		l.creates[ip] = &window{start: now, count: 1}
		return true
	}
	if w.count >= l.createLimit {
		return false
	}
	w.count++
	return true
}

func (l *Limiter) TryAcquireBucket(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets[ip] >= l.maxBuckets {
		return false
	}
	l.buckets[ip]++
	return true
}

func (l *Limiter) ReleaseBucket(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := l.buckets[ip] - 1
	if n <= 0 {
		delete(l.buckets, ip)
		return
	}
	l.buckets[ip] = n
}
