package drivemount

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestFormalProtectedPathInvariants proves defense-in-depth across randomized
// adversarial Unicode (NFD/NFKC/Default-Ignorable), nested depth, Windows 8.3
// short names, traversal, control chars, and segment length boundaries.
func TestFormalProtectedPathInvariants(t *testing.T) {
	// 1. Nested protected folders and protected files MUST be caught at every depth.
	mustProtect := []string{
		"/.claude/settings.json",
		"/a/b/c/.claude/settings.json",
		"/a/b/c/.agents/skills/x.md",
		"/a/b/c/.cursor/rules/foo.mdc",
		"/a/b/c/.github/workflows/ci.yml",
		"/a/b/c/.git/config",
		"/a/b/c/CLAUDE.md",
		"/a/b/c/AGENTS.md",
		"/a/b/c/agent.json",
		"/a/b/c/.mcp.json",
		"/a/b/c/.envrc",
		// Case-folding & Unicode confusables
		"/SUB/ClAuDe.Md",
		"/sub/\u0063laude.md",
		"/sub/.CLA\u0055DE/x",
		// Windows 8.3 short-name bypass attempts
		"/CLAUDE~1.MD",
		"/AGENTS~2.MD",
		"/AGENT~1.JSO",
		"/CLAUDE~1/settings.json",
		"/ENVRC~1",
		"/.ENVRC~1",
		"/nested/SUB/MCP~1.JSO",
		"/nested/GIT~1/config",
	}
	for _, p := range mustProtect {
		if !IsProtectedPath(p) {
			t.Errorf("expected %q to be protected, but IsProtectedPath returned false", p)
		}
	}

	// 2. Non-protected lookalikes must NOT false-positive on 8.3 matching.
	mustAllow := []string{
		"/notes/readme.md",
		"/src/environment.ts",
		"/docs/agents-guide.md",
		"/my~file.txt",
		"/CLAUDE~12345.md",
		"/foo/bar/normal.json",
	}
	for _, p := range mustAllow {
		if IsProtectedPath(p) {
			t.Errorf("expected %q NOT to be protected, but IsProtectedPath returned true", p)
		}
	}

	// 3. Default_Ignorable_Code_Point & invalid characters MUST be rejected by CleanDrivePath.
	ignorables := []rune{
		0x00AD, // soft hyphen
		0x034F, // combining grapheme joiner
		0x200B, // zero-width space
		0x200C, // ZWNJ
		0x200D, // ZWJ
		0x200E, // LRM
		0x202E, // RLO bidi override
		0x2060, // word joiner
		0xFE00, // variation selector-1
		0xFE0F, // variation selector-16
		0xFEFF, // BOM
		0x0000, // NUL
		0x001B, // ESC
		0x007F, // DEL
	}
	for _, r := range ignorables {
		candidate := "/.clau" + string(r) + "de/settings.json"
		if _, ok := CleanDrivePath(candidate); ok {
			t.Errorf("CleanDrivePath accepted ignorable/control rune U+%04X in %q", r, candidate)
		}
	}

	// 4. Randomized fuzz invariants: CleanDrivePath output NEVER contains "..", "\\",
	// control chars, or >MaxPathBytes, is idempotent, and never panics.
	rng := rand.New(rand.NewSource(42))
	alphabet := []rune("abcXYZ0123456789/._-~\\ \t\n\x00\u200b\u0301\u00e9\u034f\ufe0f")
	for i := 0; i < 500; i++ {
		n := rng.Intn(64)
		var b strings.Builder
		for j := 0; j < n; j++ {
			b.WriteRune(alphabet[rng.Intn(len(alphabet))])
		}
		raw := b.String()
		clean, ok := CleanDrivePath(raw)
		if !ok {
			continue
		}
		if !strings.HasPrefix(clean, "/") {
			t.Fatalf("clean path %q does not start with /", clean)
		}
		if len(clean) > MaxPathBytes {
			t.Fatalf("clean path len %d > %d", len(clean), MaxPathBytes)
		}
		for _, seg := range strings.Split(strings.TrimPrefix(clean, "/"), "/") {
			if seg == ".." || seg == "." {
				t.Fatalf("clean path %q leaked traversal segment %q", clean, seg)
			}
		}
		if strings.Contains(clean, "\\") {
			t.Fatalf("clean path %q leaked backslash", clean)
		}
		clean2, ok2 := CleanDrivePath(clean)
		if !ok2 || clean2 != clean {
			t.Fatalf("CleanDrivePath not idempotent: %q -> %q (%v)", clean, clean2, ok2)
		}
	}
}

// TestAdversarialWebDAVHardening proves every critical/high WebDAV remediation:
// - PROPFIND Depth:1 downloads 0 file bytes (lazy read)
// - PROPFIND Depth:infinity and omitted Depth return 403
// - PROPPATCH returns 403 and NEVER truncates existing files
// - Sec-Fetch-Site returns 403 (browser CSRF / DNS rebinding)
// - Read-only mount rejects LOCK/UNLOCK/POST/PUT/DELETE/MOVE/MKCOL and strips write methods from OPTIONS
// - Aborted PUT never calls remote Upload
// - Oversized PUT returns 413 and never uploads
// - COPY/MOVE into self or descendant returns 403
// - Protected Subpath is rejected at startup
// - AppleDouble ._* writes stay ephemeral in memory and never hit Drive API
func TestAdversarialWebDAVHardening(t *testing.T) {
	var downloads, uploads int
	var lastIfVersion, lastIfAbsent string
	files := map[string][]byte{
		"/docs/spec.md":       []byte("important specification content"),
		"/.claude/secret.txt": []byte("hidden agent config"),
	}
	versions := map[string]int64{
		"/docs/spec.md": 7,
	}

	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/files"):
			dir := r.URL.Query().Get("path")
			if dir == "" {
				dir = "/"
			}
			var entries []string
			seenFolders := map[string]bool{}
			for p, b := range files {
				if dir == "/" {
					rest := strings.TrimPrefix(p, "/")
					head, _, hasSlash := strings.Cut(rest, "/")
					if hasSlash {
						if !seenFolders["/"+head] {
							seenFolders["/"+head] = true
							entries = append(entries, `{"path":"/`+head+`","kind":"folder","size_bytes":0,"version":1,"modified_at":"2026-11-23T00:00:00Z"}`)
						}
						continue
					}
				} else if !strings.HasPrefix(p, strings.TrimSuffix(dir, "/")+"/") {
					continue
				}
				v := versions[p]
				if v == 0 {
					v = 1
				}
				entries = append(entries, `{"path":"`+p+`","kind":"file","size_bytes":`+itoa(len(b))+`,"version":`+itoa(int(v))+`,"modified_at":"2026-11-23T00:00:00Z"}`)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"files":[` + strings.Join(entries, ",") + `]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/content"):
			downloads++
			p := r.URL.Query().Get("path")
			b, ok := files[p]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(b)
		case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/content"):
			uploads++
			p := r.URL.Query().Get("path")
			lastIfVersion = r.URL.Query().Get("if_version")
			lastIfAbsent = r.URL.Query().Get("if_absent")
			b, _ := io.ReadAll(r.Body)
			files[p] = b
			versions[p]++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"path":"` + p + `","kind":"file","size_bytes":` + itoa(len(b)) + `,"version":` + itoa(int(versions[p])) + `}`))
		default:
			http.NotFound(w, r)
		}
	})

	client, err := NewDriveClient(ClientConfig{
		APIURL: "http://127.0.0.1:9999",
		Token:  ShareTokenPrefix + "testsharetoken12345",
		HTTP: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			rec := httptest.NewRecorder()
			api.ServeHTTP(rec, req)
			return rec.Result(), nil
		})},
	})
	if err != nil {
		t.Fatalf("NewDriveClient: %v", err)
	}

	// Protected subpath must be rejected at FS creation.
	if _, err := NewDriveFS(client, FSOptions{Subpath: "/.claude"}); err == nil {
		t.Fatal("expected NewDriveFS to reject protected Subpath /.claude")
	}

	// Read-only mount checks.
	roFS, err := NewDriveFS(client, FSOptions{ReadWrite: false})
	if err != nil {
		t.Fatalf("NewDriveFS RO: %v", err)
	}
	defer roFS.Close()
	roHandler, roUser, roPass, err := NewHandler(roFS, "127.0.0.1:18080")
	if err != nil {
		t.Fatalf("NewHandler RO: %v", err)
	}
	authHeader := "Basic " + base64.StdEncoding.EncodeToString([]byte(roUser+":"+roPass))

	doReq := func(h http.Handler, method, path string, body io.Reader, hdrs map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:18080"+path, body)
		req.Host = "127.0.0.1:18080"
		req.RemoteAddr = "127.0.0.1:54321"
		req.Header.Set("Authorization", authHeader)
		for k, v := range hdrs {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Sec-Fetch-Site must be 403.
	if rec := doReq(roHandler, "GET", "/docs/spec.md", nil, map[string]string{"Sec-Fetch-Site": "cross-site"}); rec.Code != http.StatusForbidden {
		t.Fatalf("Sec-Fetch-Site got %d, want 403", rec.Code)
	}
	// 2. PROPFIND Depth:infinity and omitted Depth must be 403.
	if rec := doReq(roHandler, "PROPFIND", "/", nil, map[string]string{"Depth": "infinity"}); rec.Code != http.StatusForbidden {
		t.Fatalf("PROPFIND Depth:infinity got %d, want 403", rec.Code)
	}
	if rec := doReq(roHandler, "PROPFIND", "/", nil, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("PROPFIND missing Depth got %d, want 403", rec.Code)
	}
	// 3. PROPFIND Depth:1 must download 0 file bytes (lazy read)!
	downloads = 0
	if rec := doReq(roHandler, "PROPFIND", "/docs", nil, map[string]string{"Depth": "1"}); rec.Code != http.StatusMultiStatus {
		t.Fatalf("PROPFIND Depth:1 got %d, want 207: %s", rec.Code, rec.Body.String())
	}
	if downloads != 0 {
		t.Fatalf("PROPFIND Depth:1 triggered %d downloads, want 0 (lazy read violated)", downloads)
	}
	// 4. RO OPTIONS must not advertise write/lock methods; LOCK/UNLOCK/PROPPATCH/POST must be 403.
	optRec := doReq(roHandler, "OPTIONS", "/", nil, nil)
	if strings.Contains(optRec.Header().Get("Allow"), "PUT") || strings.Contains(optRec.Header().Get("Allow"), "LOCK") {
		t.Fatalf("RO OPTIONS advertised write/lock methods: %q", optRec.Header().Get("Allow"))
	}
	for _, m := range []string{"LOCK", "UNLOCK", "PROPPATCH", "POST", "PUT", "DELETE", "MKCOL"} {
		if rec := doReq(roHandler, m, "/docs/spec.md", strings.NewReader("x"), nil); rec.Code != http.StatusForbidden {
			t.Fatalf("RO %s got %d, want 403", m, rec.Code)
		}
	}

	// Read-write mount checks.
	rwFS, err := NewDriveFS(client, FSOptions{ReadWrite: true})
	if err != nil {
		t.Fatalf("NewDriveFS RW: %v", err)
	}
	defer rwFS.Close()
	rwHandler, rwUser, rwPass, err := NewHandler(rwFS, "127.0.0.1:18080")
	if err != nil {
		t.Fatalf("NewHandler RW: %v", err)
	}
	authHeader = "Basic " + base64.StdEncoding.EncodeToString([]byte(rwUser+":"+rwPass))

	// 5. PROPPATCH on RW mount must return 403 and NEVER truncate /docs/spec.md.
	uploads = 0
	if rec := doReq(rwHandler, "PROPPATCH", "/docs/spec.md", strings.NewReader("<D:propertyupdate/>"), nil); rec.Code != http.StatusForbidden {
		t.Fatalf("RW PROPPATCH got %d, want 403", rec.Code)
	}
	if uploads != 0 || string(files["/docs/spec.md"]) != "important specification content" {
		t.Fatalf("PROPPATCH corrupted file: uploads=%d content=%q", uploads, string(files["/docs/spec.md"]))
	}

	// 6. COPY / MOVE into self or descendant must return 403.
	if rec := doReq(rwHandler, "COPY", "/docs", nil, map[string]string{"Destination": "http://127.0.0.1:18080/docs/sub"}); rec.Code != http.StatusForbidden {
		t.Fatalf("COPY into descendant got %d, want 403", rec.Code)
	}
	if rec := doReq(rwHandler, "MOVE", "/docs", nil, map[string]string{"Destination": "http://127.0.0.1:18080/docs/sub"}); rec.Code != http.StatusForbidden {
		t.Fatalf("MOVE into descendant got %d, want 403", rec.Code)
	}
	if rec := doReq(rwHandler, "MOVE", "/docs/spec.md", nil, map[string]string{"Destination": "http://evil.example/spec.md"}); rec.Code != http.StatusBadGateway && rec.Code != http.StatusForbidden {
		t.Fatalf("cross-host Destination got %d, want 502 or 403", rec.Code)
	}

	// 7. Oversized Content-Length PUT returns 413 without uploading.
	req := httptest.NewRequest("PUT", "http://127.0.0.1:18080/docs/big.bin", bytes.NewReader(nil))
	req.Host = "127.0.0.1:18080"
	req.RemoteAddr = "127.0.0.1:54321"
	req.ContentLength = MaxMountFileBytes + 1
	req.Header.Set("Authorization", authHeader)
	rec := httptest.NewRecorder()
	rwHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge || uploads != 0 {
		t.Fatalf("oversized PUT got %d (uploads=%d), want 413 and 0 uploads", rec.Code, uploads)
	}

	// 8. Aborted PUT (body fails mid-stream) must NOT call remote Upload!
	failingReq := httptest.NewRequest("PUT", "http://127.0.0.1:18080/docs/spec.md", &errReader{data: []byte("partial")})
	failingReq.Host = "127.0.0.1:18080"
	failingReq.RemoteAddr = "127.0.0.1:54321"
	failingReq.Header.Set("Authorization", authHeader)
	failingRec := httptest.NewRecorder()
	rwHandler.ServeHTTP(failingRec, failingReq)
	if uploads != 0 || string(files["/docs/spec.md"]) != "important specification content" {
		t.Fatalf("aborted PUT uploaded partial bytes! uploads=%d content=%q", uploads, string(files["/docs/spec.md"]))
	}

	// 9. Share-token optimistic concurrency: overwrite sends if_version=7, new file sends if_absent=true.
	if rec := doReq(rwHandler, "PUT", "/docs/spec.md", strings.NewReader("updated spec"), nil); rec.Code != http.StatusCreated && rec.Code != http.StatusNoContent {
		t.Fatalf("overwrite PUT got %d: %s", rec.Code, rec.Body.String())
	}
	if lastIfVersion != "7" {
		t.Fatalf("share-token overwrite sent if_version=%q, want 7", lastIfVersion)
	}
	if rec := doReq(rwHandler, "PUT", "/docs/brand-new.md", strings.NewReader("hello"), nil); rec.Code != http.StatusCreated && rec.Code != http.StatusNoContent {
		t.Fatalf("create PUT got %d: %s", rec.Code, rec.Body.String())
	}
	if lastIfAbsent != "true" {
		t.Fatalf("share-token create sent if_absent=%q, want true", lastIfAbsent)
	}

	// 10. AppleDouble ._* file writes stay in ephemeral overlay and NEVER hit Drive API.
	prevUploads := uploads
	if rec := doReq(rwHandler, "PUT", "/docs/._spec.md", strings.NewReader("appledouble-xattr"), nil); rec.Code != http.StatusCreated && rec.Code != http.StatusNoContent {
		t.Fatalf("AppleDouble PUT got %d: %s", rec.Code, rec.Body.String())
	}
	if uploads != prevUploads {
		t.Fatalf("AppleDouble write hit Drive API (uploads %d -> %d)", prevUploads, uploads)
	}
	if rec := doReq(rwHandler, "GET", "/docs/._spec.md", nil, nil); rec.Code != http.StatusOK || rec.Body.String() != "appledouble-xattr" {
		t.Fatalf("AppleDouble GET got %d %q", rec.Code, rec.Body.String())
	}
}

// TestRealLoopbackWebDAVE2E spins up a real 127.0.0.1 TCP listener via StartServer
// and exercises full HTTP WebDAV round-trips.
func TestRealLoopbackWebDAVE2E(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/files"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"files":[{"path":"/hello.txt","kind":"file","size_bytes":12,"version":1,"modified_at":"2026-11-23T00:00:00Z"}]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/content"):
			_, _ = w.Write([]byte("hello world!"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()

	client, err := NewDriveClient(ClientConfig{APIURL: api.URL, Token: "test-token", Drive: "d1"})
	if err != nil {
		t.Fatalf("NewDriveClient: %v", err)
	}
	fs, err := NewDriveFS(client, FSOptions{ReadWrite: false})
	if err != nil {
		t.Fatalf("NewDriveFS: %v", err)
	}
	defer fs.Close()
	srv, err := StartServer(fs)
	if err != nil {
		t.Fatalf("StartServer: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Close(ctx)
	}()

	user, pass := srv.Credentials()
	req, _ := http.NewRequest(http.MethodGet, strings.TrimRight(srv.URL(), "/")+"/hello.txt", nil)
	req.SetBasicAuth(user, pass)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("real loopback GET failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "hello world!" {
		t.Fatalf("real loopback GET got %d %q", resp.StatusCode, string(body))
	}
}

type errReader struct {
	data []byte
	sent bool
}

func (e *errReader) Read(p []byte) (int, error) {
	if !e.sent {
		e.sent = true
		n := copy(p, e.data)
		return n, errors.New("simulated mid-stream connection reset")
	}
	return 0, io.ErrUnexpectedEOF
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
