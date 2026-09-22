package relay

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"math/bits"
	"strings"
	"time"
)

// Proof-of-work gate before the WS upgrade completes. Stateless: the
// challenge is a nonce + expiry signed with a server-held secret (generated
// once at startup, never persisted), so verification needs no per-challenge
// storage. This only raises the cost of automated connect/bucket-farming —
// it is independent of, and does not touch, E2EE or the room PIN.
//
// Wire format:
//   challenge := base64url(nonce[16] || expiryUnix[8]) + "." + base64url(hmac)
//   client solves: find `solution` such that sha256(challenge + solution) has
//   at least cfg.PowDifficultyBits leading zero bits.
//   query param: pow=<challenge>:<solution>

const powChallengeTTL = 30 * time.Second

func (s *Server) issuePowChallenge() string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf[:16])
	binary.BigEndian.PutUint64(buf[16:], uint64(time.Now().Add(powChallengeTTL).Unix()))
	mac := hmac.New(sha256.New, s.powSecret)
	mac.Write(buf)
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(buf) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// verifyPow checks a "<challenge>:<solution>" query value against the
// server secret, expiry, and configured difficulty.
func (s *Server) verifyPow(param string) bool {
	challenge, solution, ok := splitOnce(param, ":")
	if !ok || solution == "" {
		return false
	}

	nonceB64, sigB64, ok := splitOnce(challenge, ".")
	if !ok {
		return false
	}
	buf, err := base64.RawURLEncoding.DecodeString(nonceB64)
	if err != nil || len(buf) != 24 {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, s.powSecret)
	mac.Write(buf)
	expected := mac.Sum(nil)
	if !hmac.Equal(sig, expected) {
		return false
	}

	expiry := int64(binary.BigEndian.Uint64(buf[16:]))
	if time.Now().Unix() > expiry {
		return false
	}

	h := sha256.Sum256([]byte(challenge + solution))
	return leadingZeroBits(h[:]) >= s.cfg.PowDifficultyBits
}

func splitOnce(s, sep string) (before, after string, ok bool) {
	i := strings.Index(s, sep)
	if i < 0 {
		return "", "", false
	}
	return s[:i], s[i+len(sep):], true
}

func leadingZeroBits(h []byte) int {
	n := 0
	for _, b := range h {
		if b == 0 {
			n += 8
			continue
		}
		n += bits.LeadingZeros8(b)
		break
	}
	return n
}
