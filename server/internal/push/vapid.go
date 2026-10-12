// Package push sends content-free Web Push notifications (RFC 8030) authed
// with VAPID (RFC 8292). Pushes carry no payload, so no RFC 8291 message
// encryption is needed and the relay never handles anything chat-related.
package push

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"
)

const (
	jwtLifetime = 12 * time.Hour
	// Refresh cached JWTs well before expiry so in-flight requests never
	// carry a token that lapses at the push service.
	jwtRefreshMargin = time.Hour
)

var b64 = base64.RawURLEncoding

type VAPID struct {
	priv    *ecdsa.PrivateKey
	pub     string
	subject string
	now     func() time.Time

	mu    sync.Mutex
	cache map[string]cachedJWT
}

type cachedJWT struct {
	token string
	exp   time.Time
}

// NewVAPID loads the base64url-encoded P-256 private scalar, or generates a
// fresh key when privB64 is empty.
func NewVAPID(privB64, subject string) (*VAPID, error) {
	var priv *ecdsa.PrivateKey
	if privB64 == "" {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("vapid keygen: %w", err)
		}
		priv = k
	} else {
		raw, err := b64.DecodeString(privB64)
		if err != nil {
			return nil, fmt.Errorf("vapid key: %w", err)
		}
		k, err := ecdsaFromScalar(raw)
		if err != nil {
			return nil, err
		}
		priv = k
	}
	ek, err := priv.PublicKey.ECDH()
	if err != nil {
		return nil, fmt.Errorf("vapid pub: %w", err)
	}
	return &VAPID{
		priv:    priv,
		pub:     b64.EncodeToString(ek.Bytes()),
		subject: subject,
		now:     time.Now,
		cache:   make(map[string]cachedJWT),
	}, nil
}

func ecdsaFromScalar(d []byte) (*ecdsa.PrivateKey, error) {
	ek, err := ecdh.P256().NewPrivateKey(d)
	if err != nil {
		return nil, fmt.Errorf("vapid key: %w", err)
	}
	pt := ek.PublicKey().Bytes() // 0x04 || X || Y
	if len(pt) != 65 {
		return nil, errors.New("vapid key: unexpected public point length")
	}
	return &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(pt[1:33]),
			Y:     new(big.Int).SetBytes(pt[33:]),
		},
		D: new(big.Int).SetBytes(d),
	}, nil
}

// PublicKey is the uncompressed application server key, base64url, as the
// browser expects for pushManager.subscribe({ applicationServerKey }).
func (v *VAPID) PublicKey() string { return v.pub }

// AuthHeader returns the Authorization header value for an endpoint origin.
func (v *VAPID) AuthHeader(audience string) (string, error) {
	tok, err := v.token(audience)
	if err != nil {
		return "", err
	}
	return "vapid t=" + tok + ", k=" + v.pub, nil
}

func (v *VAPID) token(audience string) (string, error) {
	now := v.now()
	v.mu.Lock()
	defer v.mu.Unlock()
	if c, ok := v.cache[audience]; ok && now.Add(jwtRefreshMargin).Before(c.exp) {
		return c.token, nil
	}
	exp := now.Add(jwtLifetime)
	tok, err := v.sign(audience, exp)
	if err != nil {
		return "", err
	}
	v.cache[audience] = cachedJWT{token: tok, exp: exp}
	return tok, nil
}

func (v *VAPID) sign(audience string, exp time.Time) (string, error) {
	header := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, err := json.Marshal(struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}{audience, exp.Unix(), v.subject})
	if err != nil {
		return "", err
	}
	signingInput := header + "." + b64.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, v.priv, sum[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signingInput + "." + b64.EncodeToString(sig), nil
}
