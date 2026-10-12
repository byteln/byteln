package push

import (
	"net/url"
	"strings"
)

// Push endpoints are client-supplied URLs the relay will POST to, so they are
// restricted to the browser vendors' push services to rule out SSRF.
var (
	allowedHosts = []string{
		"fcm.googleapis.com",
		"updates.push.services.mozilla.com",
		"web.push.apple.com",
	}
	allowedSuffixes = []string{
		".push.services.mozilla.com",
		".push.apple.com",
		".notify.windows.com",
	}
)

// AllowedEndpoint reports whether u is an https URL on a known push service.
func AllowedEndpoint(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	if p := u.Port(); p != "" && p != "443" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range allowedHosts {
		if host == h {
			return true
		}
	}
	for _, s := range allowedSuffixes {
		if strings.HasSuffix(host, s) && len(host) > len(s) {
			return true
		}
	}
	return false
}
