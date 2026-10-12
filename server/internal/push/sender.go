package push

import (
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// MaxEndpointLen bounds what the relay will hold per seat.
const MaxEndpointLen = 1024

var ErrEndpointNotAllowed = errors.New("push endpoint not allowed")

type Sender struct {
	vapid  *VAPID
	ttl    time.Duration
	client *http.Client
	allow  func(*url.URL) bool
	sem    chan struct{}
}

// NewSender builds a sender whose pushes expire at the push service after
// ttl — matching the relay buffer, since a later wakeup would find nothing.
func NewSender(v *VAPID, ttl time.Duration, maxInFlight int) *Sender {
	if maxInFlight <= 0 {
		maxInFlight = 64
	}
	return &Sender{
		vapid:  v,
		ttl:    ttl,
		client: &http.Client{Timeout: 5 * time.Second},
		allow:  AllowedEndpoint,
		sem:    make(chan struct{}, maxInFlight),
	}
}

func (s *Sender) PublicKey() string { return s.vapid.PublicKey() }

// SetTransport overrides the HTTP client and endpoint policy (tests only).
func (s *Sender) SetTransport(c *http.Client, allow func(*url.URL) bool) {
	s.client = c
	s.allow = allow
}

// ValidateEndpoint checks a client-supplied endpoint before it is stored.
func (s *Sender) ValidateEndpoint(endpoint string) error {
	if endpoint == "" || len(endpoint) > MaxEndpointLen {
		return ErrEndpointNotAllowed
	}
	u, err := url.Parse(endpoint)
	if err != nil || !s.allow(u) {
		return ErrEndpointNotAllowed
	}
	return nil
}

// Send fires an empty push asynchronously. Drops the push when too many are
// already in flight rather than queueing. onGone runs when the push service
// reports the subscription expired (404/410).
func (s *Sender) Send(endpoint string, onGone func()) {
	select {
	case s.sem <- struct{}{}:
	default:
		return
	}
	go func() {
		defer func() { <-s.sem }()
		if err := s.send(endpoint, onGone); err != nil {
			log.Printf("push: %v", err)
		}
	}()
}

func (s *Sender) send(endpoint string, onGone func()) error {
	u, err := url.Parse(endpoint)
	if err != nil || !s.allow(u) {
		return ErrEndpointNotAllowed
	}
	auth, err := s.vapid.AuthHeader(u.Scheme + "://" + u.Host)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, http.NoBody)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("TTL", strconv.Itoa(int(s.ttl/time.Second)))
	req.Header.Set("Urgency", "high")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		if onGone != nil {
			onGone()
		}
	case resp.StatusCode >= 300:
		return errors.New("push service status " + strconv.Itoa(resp.StatusCode))
	}
	return nil
}
