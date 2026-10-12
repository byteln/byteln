package relay

import (
	"net/http"
	"net/url"
)

// SetPushTransport lets external tests point pushes at a local stub.
func (s *Server) SetPushTransport(c *http.Client, allow func(*url.URL) bool) {
	s.push.SetTransport(c, allow)
}
