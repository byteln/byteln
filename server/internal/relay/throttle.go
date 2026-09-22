package relay

import (
	"math"
	"time"
)

// tokenBucket is a per-connection throughput limiter. It is only ever
// touched from a single Peer's own read loop (readPeer serializes access via
// p.reading), so it needs no internal locking.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

// newTokenBucket seeds the bucket with an initial burst allowance so the
// first frame(s) on a fresh connection aren't throttled.
func newTokenBucket(initialTokens float64, now time.Time) *tokenBucket {
	return &tokenBucket{tokens: initialTokens, last: now}
}

// allow reports whether cost units may be spent now, given the current
// (possibly adaptively-tightened) ratePerSec. ratePerSec <= 0 disables the
// limiter entirely (unlimited), matching the config convention used
// elsewhere (e.g. MaxFrameBytes).
func (t *tokenBucket) allow(now time.Time, cost, ratePerSec float64) bool {
	if ratePerSec <= 0 {
		return true
	}
	if elapsed := now.Sub(t.last).Seconds(); elapsed > 0 {
		t.tokens += elapsed * ratePerSec
		if cap := ratePerSec * 2; t.tokens > cap {
			t.tokens = cap
		}
		t.last = now
	}
	if t.tokens >= cost {
		t.tokens -= cost
		return true
	}
	return false
}

// shapeStats tracks lightweight traffic-shape signals for a connection:
// how uniform the frame sizes and inter-arrival timing are. A human chatting
// produces small, irregular frames with irregular gaps; a continuous
// chunked file transfer (or any scripted sender) produces long runs of
// near-identical frame sizes at machine-regular intervals. This is a signal,
// not proof of "not our client" — see the plan doc — so it is only ever used
// to tighten the existing per-connection rate limiter, never as a hard block.
type shapeStats struct {
	haveLast bool
	lastAt   time.Time

	emaIntervalMs    float64
	emaIntervalVarMs float64
	emaSize          float64
	emaSizeVar       float64
	samples          int
}

const shapeEMAAlpha = 0.2
const shapeMinSamples = 8

// observe records one frame and reports whether the connection currently
// looks bot-like: a sustained run of low-variance, large, evenly-spaced
// frames (the signature of chunked file transfer rather than typed chat).
func (s *shapeStats) observe(now time.Time, size int) bool {
	sz := float64(size)
	if !s.haveLast {
		s.haveLast = true
		s.lastAt = now
		s.emaSize = sz
		return false
	}

	intervalMs := now.Sub(s.lastAt).Seconds() * 1000
	s.lastAt = now

	di := intervalMs - s.emaIntervalMs
	s.emaIntervalMs += shapeEMAAlpha * di
	s.emaIntervalVarMs = (1 - shapeEMAAlpha) * (s.emaIntervalVarMs + shapeEMAAlpha*di*di)

	ds := sz - s.emaSize
	s.emaSize += shapeEMAAlpha * ds
	s.emaSizeVar = (1 - shapeEMAAlpha) * (s.emaSizeVar + shapeEMAAlpha*ds*ds)

	s.samples++
	if s.samples < shapeMinSamples {
		return false
	}

	intervalCV := 0.0
	if s.emaIntervalMs > 0 {
		intervalCV = math.Sqrt(s.emaIntervalVarMs) / s.emaIntervalMs
	}
	sizeCV := 0.0
	if s.emaSize > 0 {
		sizeCV = math.Sqrt(s.emaSizeVar) / s.emaSize
	}

	// Low variance in both timing and size, sustained at a large-ish frame
	// size (chat text is small; chunked transfers use large fixed chunks),
	// is the bot/file-transfer signature.
	const (
		lowIntervalCV  = 0.15
		lowSizeCV      = 0.10
		botLikeMinSize = 32 << 10 // 32 KiB — well above typical chat text
	)
	return intervalCV < lowIntervalCV && sizeCV < lowSizeCV && s.emaSize > botLikeMinSize
}
