package relay

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"strings"
)

// bufConn wraps a net.Conn with a replaceable reader (for request replay).
type bufConn struct {
	net.Conn
	r io.Reader
}

func newBufConn(c net.Conn) *bufConn {
	br := bufio.NewReaderSize(c, 4096)
	return &bufConn{Conn: c, r: br}
}

func (c *bufConn) Read(p []byte) (int, error) {
	return c.r.Read(p)
}

func (c *bufConn) setReader(r io.Reader) {
	c.r = r
}

// readHTTPHeaders reads the request line + headers, returning the raw bytes
// so the caller can replay them into an upgrader.
func readHTTPHeaders(c *bufConn) (raw []byte, reqLine string, headers map[string]string, err error) {
	br, ok := c.r.(*bufio.Reader)
	if !ok {
		br = bufio.NewReader(c.r)
		c.r = br
	}
	var buf bytes.Buffer
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, "", nil, err
	}
	buf.WriteString(line)
	reqLine = strings.TrimRight(line, "\r\n")
	headers = make(map[string]string)
	for {
		h, err := br.ReadString('\n')
		if err != nil {
			return nil, "", nil, err
		}
		buf.WriteString(h)
		hTrim := strings.TrimRight(h, "\r\n")
		if hTrim == "" {
			break
		}
		i := strings.IndexByte(hTrim, ':')
		if i < 0 {
			continue
		}
		k := http.CanonicalHeaderKey(strings.TrimSpace(hTrim[:i]))
		v := strings.TrimSpace(hTrim[i+1:])
		headers[k] = v
	}
	return buf.Bytes(), reqLine, headers, nil
}

func parseReqLine(line string) (method, path, proto string) {
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 2 {
		return "", "", ""
	}
	method = parts[0]
	path = parts[1]
	if len(parts) == 3 {
		proto = parts[2]
	}
	return
}

func replayRequest(c *bufConn, raw []byte) {
	br, _ := c.r.(*bufio.Reader)
	if br == nil {
		c.r = io.MultiReader(bytes.NewReader(raw), c.Conn)
		return
	}
	c.r = io.MultiReader(bytes.NewReader(raw), br)
}
