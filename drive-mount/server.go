package drivemount

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"
)

// Server wraps DriveFS behind a hardened loopback-only WebDAV HTTP server.
// Security invariants:
//  1. Listens strictly on 127.0.0.1:<ephemeral-port> (never 0.0.0.0 or LAN).
//  2. Refuses any request whose RemoteAddr is not loopback.
//  3. Refuses DNS-rebinding Host headers (allows only 127.0.0.1:<port> or localhost:<port>).
//  4. Refuses browser cross-origin/fetch-metadata headers (Origin, Sec-Fetch-Site).
//  5. Requires a per-mount 256-bit ephemeral Basic Auth secret verified in constant time.
//  6. Rejects PROPFIND Depth:infinity (403 propfind-finite-depth) and PROPPATCH (403).
//  7. Refuses LOCK/UNLOCK/POST/write methods and advertises RO OPTIONS on read-only mounts.
//  8. Blocks recursive COPY/MOVE into self or descendant and tracks PUT body completion.
type Server struct {
	fs       *DriveFS
	listener net.Listener
	httpSrv  *http.Server
	addr     string
	username string
	secret   string
}

type putTrackerKey struct{}

type copyTrackerKey struct{}

type copyStatusTracker struct {
	mu  sync.Mutex
	err error
}

func (c *copyStatusTracker) RecordError(err error) {
	if err == nil {
		return
	}
	c.mu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.mu.Unlock()
}

func (c *copyStatusTracker) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func copyTrackerFromContext(ctx context.Context) *copyStatusTracker {
	if ctx == nil {
		return nil
	}
	t, _ := ctx.Value(copyTrackerKey{}).(*copyStatusTracker)
	return t
}

// pathsOverlap reports whether a and b refer to the same Drive entry or one is
// an ancestor of the other under Drive's case-folded / Unicode-equivalent keys.
func pathsOverlap(a, b string) bool {
	sa := splitPath(a)
	sb := splitPath(b)
	n := len(sa)
	if len(sb) < n {
		n = len(sb)
	}
	for i := 0; i < n; i++ {
		if Key(sa[i]) != Key(sb[i]) {
			return false
		}
	}
	return true
}

type putBodyTracker struct {
	r             io.ReadCloser
	expectedBytes int64

	mu      sync.Mutex
	readN   int64
	sawEOF  bool
	readErr error
}

func (t *putBodyTracker) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	t.mu.Lock()
	t.readN += int64(n)
	if errors.Is(err, io.EOF) {
		t.sawEOF = true
	} else if err != nil {
		t.readErr = err
	}
	t.mu.Unlock()
	return n, err
}

func (t *putBodyTracker) Close() error { return t.r.Close() }

func (t *putBodyTracker) CompletedCleanly() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.readErr != nil {
		return false
	}
	if t.expectedBytes >= 0 && t.readN != t.expectedBytes {
		return false
	}
	return t.sawEOF || t.expectedBytes == 0
}

func putTrackerFromContext(ctx context.Context) *putBodyTracker {
	if ctx == nil {
		return nil
	}
	t, _ := ctx.Value(putTrackerKey{}).(*putBodyTracker)
	return t
}

// StartServer starts a hardened loopback WebDAV server for fs.
func StartServer(fs *DriveFS) (*Server, error) {
	if fs == nil {
		return nil, errors.New("drive filesystem is required")
	}
	var rawSecret [32]byte
	if _, err := rand.Read(rawSecret[:]); err != nil {
		return nil, fmt.Errorf("generate mount secret: %w", err)
	}
	secret := hex.EncodeToString(rawSecret[:])
	username := "caveman"

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen loopback: %w", err)
	}
	addr := ln.Addr().String()
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		_ = ln.Close()
		return nil, errors.New("invalid loopback listener address")
	}
	allowedHosts := map[string]bool{
		addr:                true,
		"localhost:" + port: true,
		"[::1]:" + port:     true,
	}

	dav := &webdav.Handler{
		FileSystem: fs,
		LockSystem: webdav.NewMemLS(),
	}

	s := &Server{
		fs:       fs,
		listener: ln,
		addr:     addr,
		username: username,
		secret:   secret,
	}

	mux := s.buildHandler(dav, allowedHosts)

	s.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		_ = s.httpSrv.Serve(ln)
	}()

	return s, nil
}

// NewHandler builds the hardened WebDAV HTTP handler without opening a TCP
// listener (useful for hermetic tests and custom transports).
func NewHandler(fs *DriveFS, hostAddr string) (http.Handler, string, string, error) {
	if fs == nil {
		return nil, "", "", errors.New("drive filesystem is required")
	}
	_, port, err := net.SplitHostPort(hostAddr)
	if err != nil || port == "" {
		return nil, "", "", errors.New("hostAddr must be host:port")
	}
	var rawSecret [32]byte
	if _, err := rand.Read(rawSecret[:]); err != nil {
		return nil, "", "", fmt.Errorf("generate mount secret: %w", err)
	}
	secret := hex.EncodeToString(rawSecret[:])
	username := "caveman"
	allowedHosts := map[string]bool{
		strings.ToLower(hostAddr): true,
		"localhost:" + port:       true,
		"[::1]:" + port:           true,
	}
	s := &Server{fs: fs, addr: hostAddr, username: username, secret: secret}
	dav := &webdav.Handler{FileSystem: fs, LockSystem: webdav.NewMemLS()}
	return s.buildHandler(dav, allowedHosts), username, secret, nil
}

func (s *Server) buildHandler(dav *webdav.Handler, allowedHosts map[string]bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		// 1. Strict loopback remote peer check.
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		// 2. Strict Host header check (prevents DNS rebinding).
		if !allowedHosts[strings.ToLower(strings.TrimSpace(r.Host))] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}

		// 3. Reject browser cross-origin and Fetch metadata requests.
		if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") != "" {
			http.Error(w, "origin refused", http.StatusForbidden)
			return
		}

		// 4. Constant-time per-mount Basic Auth verification.
		if !s.checkBasicAuth(r.Header.Get("Authorization")) {
			w.Header().Set("WWW-Authenticate", `Basic realm="Caveman Drive"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// 5. Reject dead-property PROPPATCH (prevents O_RDWR file-truncation quirks).
		if r.Method == "PROPPATCH" {
			http.Error(w, "proppatch not supported", http.StatusForbidden)
			return
		}

		// 6. Reject PROPFIND Depth:infinity (or omitted Depth) per RFC 4918 §9.1.
		if r.Method == "PROPFIND" {
			depth := strings.ToLower(strings.TrimSpace(r.Header.Get("Depth")))
			if depth != "0" && depth != "1" {
				w.Header().Set("Content-Type", "application/xml; charset=utf-8")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`))
				return
			}
		}

		// 7. Strict read-only enforcement (including LOCK, UNLOCK, POST, and RO OPTIONS).
		if !s.fs.readWrite {
			if r.Method == http.MethodOptions {
				w.Header().Set("DAV", "1")
				w.Header().Set("Allow", "OPTIONS, GET, HEAD, PROPFIND")
				w.Header().Set("MS-Author-Via", "DAV")
				w.WriteHeader(http.StatusOK)
				return
			}
			switch r.Method {
			case http.MethodPut, http.MethodDelete, http.MethodPost, "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK":
				http.Error(w, "read-only mount", http.StatusForbidden)
				return
			}
		}

		// 8. Guard COPY/MOVE against overlapping paths (self, case-equivalent, ancestor,
		//    or descendant) using Drive's normalized per-segment keys so WebDAV never
		//    deletes the source before moving. Handle case-only renames directly without
		//    x/net/webdav's delete-first Overwrite path.
		if r.Method == "COPY" || r.Method == "MOVE" {
			if destRaw := strings.TrimSpace(r.Header.Get("Destination")); destRaw != "" {
				destURL, uerr := url.Parse(destRaw)
				if uerr != nil {
					http.Error(w, "invalid destination", http.StatusBadRequest)
					return
				}
				if destURL.Host != "" && !allowedHosts[strings.ToLower(destURL.Host)] {
					http.Error(w, "cross-host destination refused", http.StatusBadGateway)
					return
				}
				srcClean, okS := CleanDrivePath(r.URL.Path)
				dstClean, okD := CleanDrivePath(destURL.Path)
				if !okS || !okD || dstClean == srcClean {
					http.Error(w, "invalid destination path", http.StatusForbidden)
					return
				}
				// Case-only / Unicode-equivalent rename of the same entry: bypass x/net/webdav's
				// RemoveAll(dst)-before-Rename flow so the source is never deleted.
				if r.Method == "MOVE" && sameSegmentPath(srcClean, dstClean) {
					if err := s.fs.Rename(r.Context(), srcClean, dstClean); err != nil {
						switch {
						case errors.Is(err, os.ErrNotExist):
							http.Error(w, "not found", http.StatusNotFound)
						case errors.Is(err, os.ErrPermission):
							http.Error(w, "forbidden", http.StatusForbidden)
						default:
							http.Error(w, "move failed", http.StatusInternalServerError)
						}
						return
					}
					w.WriteHeader(http.StatusNoContent)
					return
				}
				// Reject any ancestor/descendant overlap in EITHER direction (/A -> /A/B or /A/B -> /A)
				// as well as case-equivalent COPY destinations.
				if pathsOverlap(srcClean, dstClean) {
					http.Error(w, "overlapping destination path", http.StatusForbidden)
					return
				}
			}
			if r.Method == "MOVE" && r.Header.Get("Overwrite") == "" {
				r.Header.Set("Overwrite", "T")
			}
			if r.Method == "COPY" {
				ct := &copyStatusTracker{}
				r = r.WithContext(context.WithValue(r.Context(), copyTrackerKey{}, ct))
			}
		}

		// 9. Track PUT request-body completion so truncated/aborted PUTs never commit.
		if r.Method == http.MethodPut && r.Body != nil {
			if r.ContentLength > MaxMountFileBytes {
				http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
				return
			}
			tracker := &putBodyTracker{r: r.Body, expectedBytes: r.ContentLength}
			r = r.WithContext(context.WithValue(r.Context(), putTrackerKey{}, tracker))
			r.Body = tracker
		}

		dav.ServeHTTP(w, r)
	})
}

func (s *Server) checkBasicAuth(header string) bool {
	if len(header) < 6 || !strings.EqualFold(header[:6], "Basic ") {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header[6:]))
	if err != nil {
		return false
	}
	user, pass, ok := strings.Cut(string(decoded), ":")
	if !ok {
		return false
	}
	uOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.username)) == 1
	pOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.secret)) == 1
	return uOK && pOK
}

// Addr returns the loopback host:port (e.g., 127.0.0.1:54321).
func (s *Server) Addr() string { return s.addr }

// URL returns the unauthenticated loopback WebDAV URL (without embedded secrets).
func (s *Server) URL() string { return "http://" + s.addr + "/" }

// Credentials returns the ephemeral per-mount username and secret.
func (s *Server) Credentials() (username, secret string) { return s.username, s.secret }

// Close gracefully stops the loopback WebDAV server and cleans up staging files.
func (s *Server) Close(ctx context.Context) error {
	var firstErr error
	if s.httpSrv != nil {
		if err := s.httpSrv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			firstErr = err
		}
	}
	if s.fs != nil {
		if err := s.fs.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
