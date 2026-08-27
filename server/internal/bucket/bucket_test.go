package bucket_test

import (
	"testing"
	"time"

	"github.com/byteln/byteln/server/internal/bucket"
)

func testCfg(now *time.Time) bucket.Config {
	return bucket.Config{
		IdleTTL:         10 * time.Minute,
		BufferTTL:       60 * time.Second,
		ReclaimTTL:      30 * time.Second,
		MaxBufferFrames: 8,
		Now: func() time.Time {
			if now == nil {
				return time.Now()
			}
			return *now
		},
	}
}

func TestJoinTwoPeersFull(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	j1 := reg.Join("abc", "tokA", "1.1.1.1", "connA")
	if j1.Rejected || j1.Slot != 0 || !j1.Created {
		t.Fatalf("join1: %+v", j1)
	}
	j2 := reg.Join("abc", "tokB", "2.2.2.2", "connB")
	if j2.Rejected || j2.Slot != 1 {
		t.Fatalf("join2: %+v", j2)
	}
	j3 := reg.Join("abc", "tokC", "3.3.3.3", "connC")
	if !j3.Rejected || j3.Reason != "full" {
		t.Fatalf("join3 should be full: %+v", j3)
	}
}

func TestTokenReclaim(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "1.1.1.1", "c1")
	reg.Join("b1", "tokB", "2.2.2.2", "c2")

	del, _, _ := reg.Leave("b1", 0)
	if del {
		t.Fatal("should not delete while peer B connected")
	}

	now = now.Add(10 * time.Second)
	jr := reg.Join("b1", "tokA", "1.1.1.1", "c1b")
	if jr.Rejected || jr.Slot != 0 {
		t.Fatalf("reclaim failed: %+v", jr)
	}
}

func TestReclaimExpired(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "1.1.1.1", "c1")
	reg.Leave("b1", 0)

	now = now.Add(31 * time.Second)
	jr := reg.Join("b1", "tokZ", "9.9.9.9", "cZ")
	if jr.Rejected || jr.Slot != 0 {
		t.Fatalf("expected free slot after grace: %+v", jr)
	}
}

func TestBufferWhenAlone(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	j := reg.Join("b1", "tokA", "1.1.1.1", "c1")
	b := j.Bucket

	if !reg.BufferIfAlone(b, 0, []byte("hi"), true) {
		t.Fatal("expected buffer")
	}
	frames := reg.DrainBuffer(b)
	if len(frames) != 1 || string(frames[0].Data) != "hi" {
		t.Fatalf("drain: %+v", frames)
	}
}

func TestBufferTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	j := reg.Join("b1", "tokA", "1.1.1.1", "c1")
	reg.BufferIfAlone(j.Bucket, 0, []byte("old"), true)
	now = now.Add(61 * time.Second)
	frames := reg.DrainBuffer(j.Bucket)
	if len(frames) != 0 {
		t.Fatalf("expected expired buffer empty, got %d", len(frames))
	}
}

func TestBothLeaveDeletes(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "1.1.1.1", "c1")
	reg.Join("b1", "tokB", "2.2.2.2", "c2")
	reg.Leave("b1", 0)
	now = now.Add(31 * time.Second)
	del, _, _ := reg.Leave("b1", 1)
	if !del {
		now = now.Add(31 * time.Second)
		_ = reg.SweepIdle()
	}
	if reg.Get("b1") != nil {
		t.Fatal("bucket should be gone")
	}
}

func TestNoBufferWhenPeerPresent(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	j1 := reg.Join("b1", "a", "1.1.1.1", "c1")
	reg.Join("b1", "b", "2.2.2.2", "c2")
	if reg.BufferIfAlone(j1.Bucket, 0, []byte("x"), true) {
		t.Fatal("should not buffer when peer connected")
	}
}
