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
	j1 := reg.Join("abc", "tokA", "sidA", "1.1.1.1", "connA")
	if j1.Rejected || j1.Slot != 0 || !j1.Created {
		t.Fatalf("join1: %+v", j1)
	}
	j2 := reg.Join("abc", "tokB", "sidB", "2.2.2.2", "connB")
	if j2.Rejected || j2.Slot != 1 {
		t.Fatalf("join2: %+v", j2)
	}
	j3 := reg.Join("abc", "tokC", "sidC", "3.3.3.3", "connC")
	if !j3.Rejected || j3.Reason != "full" {
		t.Fatalf("join3 should be full: %+v", j3)
	}
}

func TestPartnerJoinsWhenCreatorAlone(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	j1 := reg.Join("abc", "tokCreator", "sidA", "1.1.1.1", "connA")
	if j1.Rejected || j1.Slot != 0 {
		t.Fatalf("creator join: %+v", j1)
	}
	j2 := reg.Join("abc", "tokPartner", "sidB", "2.2.2.2", "connB")
	if j2.Rejected || j2.Slot != 1 {
		t.Fatalf("partner join: %+v", j2)
	}
}

func TestLegacyEmptySidReclaimAdoptsNewSid(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	j1 := reg.Join("abc", "tokA", "", "1.1.1.1", "connA")
	if j1.Rejected {
		t.Fatalf("join1: %+v", j1)
	}
	j2 := reg.Join("abc", "tokA", "sid-new", "1.1.1.1", "connA2")
	if j2.Rejected || j2.Slot != 0 {
		t.Fatalf("legacy reclaim should adopt sid: %+v", j2)
	}
}

func TestDifferentDeviceSessionSameTokenRejectedWhenSeatLive(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	j1 := reg.Join("abc", "tokA", "sidA", "1.1.1.1", "connA")
	if j1.Rejected {
		t.Fatalf("join1: %+v", j1)
	}
	j2 := reg.Join("abc", "tokB", "sidB", "2.2.2.2", "connB")
	if j2.Rejected {
		t.Fatalf("join2: %+v", j2)
	}
	j3 := reg.Join("abc", "tokB", "sidC", "3.3.3.3", "connC")
	if !j3.Rejected || j3.Reason != "full" {
		t.Fatalf("join3 should be full: %+v", j3)
	}
}

func TestReconnectReplacesWhenPartnerAlsoConnected(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	reg.Join("abc", "tokA", "sidA", "1.1.1.1", "connA")
	reg.Join("abc", "tokB", "sidB", "2.2.2.2", "connB")
	jr := reg.Join("abc", "tokA", "sidA", "1.1.1.1", "connA2")
	if jr.Rejected || jr.Slot != 0 {
		t.Fatalf("refresh with partner connected should replace own seat: %+v", jr)
	}
}

func TestReconnectSameDeviceSessionReplaces(t *testing.T) {
	reg := bucket.NewRegistry(testCfg(nil))
	j1 := reg.Join("abc", "tokA", "sidA", "1.1.1.1", "connA")
	if j1.Rejected {
		t.Fatalf("join1: %+v", j1)
	}
	j2 := reg.Join("abc", "tokA", "sidA", "1.1.1.1", "connA2")
	if j2.Rejected || j2.Slot != 0 {
		t.Fatalf("reconnect should replace: %+v", j2)
	}
}

func TestReconnectAfterTTLAllowsNewDevice(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Leave("b1", 0)

	now = now.Add(31 * time.Second)
	jr := reg.Join("b1", "tokA", "sidZ", "9.9.9.9", "cZ")
	if jr.Rejected || jr.Slot != 0 {
		t.Fatalf("expected new device after grace: %+v", jr)
	}
}

func TestTokenReclaim(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Join("b1", "tokB", "sidB", "2.2.2.2", "c2")

	del, _, _ := reg.Leave("b1", 0)
	if del {
		t.Fatal("should not delete while peer B connected")
	}

	now = now.Add(10 * time.Second)
	jr := reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1b")
	if jr.Rejected || jr.Slot != 0 {
		t.Fatalf("reclaim failed: %+v", jr)
	}
}

func TestReclaimExpired(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Leave("b1", 0)

	now = now.Add(31 * time.Second)
	jr := reg.Join("b1", "tokZ", "sidZ", "9.9.9.9", "cZ")
	if jr.Rejected || jr.Slot != 0 {
		t.Fatalf("expected free slot after grace: %+v", jr)
	}
}

func TestDifferentDeviceDuringReclaimRejected(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Leave("b1", 0)

	now = now.Add(10 * time.Second)
	jr := reg.Join("b1", "tokA", "sidOther", "9.9.9.9", "cOther")
	if !jr.Rejected || jr.Reason != "full" {
		t.Fatalf("expected reject during reclaim window: %+v", jr)
	}
}

func TestBufferWhenAlone(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	j := reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
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
	j := reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
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
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Join("b1", "tokB", "sidB", "2.2.2.2", "c2")
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
	j1 := reg.Join("b1", "a", "sidA", "1.1.1.1", "c1")
	reg.Join("b1", "b", "sidB", "2.2.2.2", "c2")
	if reg.BufferIfAlone(j1.Bucket, 0, []byte("x"), true) {
		t.Fatal("should not buffer when peer connected")
	}
}

func TestConnectedBucketNotSweptWhenIdle(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Join("b1", "tokB", "sidB", "2.2.2.2", "c2")

	now = now.Add(11 * time.Minute)
	_ = reg.SweepIdle()
	if reg.Get("b1") == nil {
		t.Fatal("connected bucket should not be swept while peers remain connected")
	}
}

func TestIdleEmptyBucketSwept(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	reg.Leave("b1", 0)

	now = now.Add(31 * time.Second)
	_ = reg.SweepIdle()
	if reg.Get("b1") != nil {
		t.Fatal("empty bucket should be swept after reclaim window")
	}
}

func TestTouchUpdatesLastSeen(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reg := bucket.NewRegistry(testCfg(&now))
	j := reg.Join("b1", "tokA", "sidA", "1.1.1.1", "c1")
	b := j.Bucket

	now = now.Add(9 * time.Minute)
	b.Touch()

	now = now.Add(2 * time.Minute)
	_ = reg.SweepIdle()
	if reg.Get("b1") == nil {
		t.Fatal("Touch should refresh idle timer and keep bucket alive")
	}
}
