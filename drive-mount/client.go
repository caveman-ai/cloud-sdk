package drivemount

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// ShareTokenPrefix identifies a Caveman Drive folder share token.
	ShareTokenPrefix = "cdrv_"
	// DefaultAPIURL is hosted Caveman Cloud's API origin.
	DefaultAPIURL = "https://api.caveman.so"
	// MaxMountFileBytes caps a single file read/written through the local mount (256 MiB).
	MaxMountFileBytes int64 = 256 << 20
	maxJSONReplyBytes int64 = 4 << 20
	maxListPages            = 100
	maxListEntries          = 100_000
)

var (
	// ErrNotFound maps Drive 404s.
	ErrNotFound = errors.New("drive path not found")
	// ErrPermission maps Drive 401/403s or read-only refusals.
	ErrPermission = errors.New("drive permission denied")
	// ErrConflict maps Drive 409/412s (already exists, version mismatch, non-empty).
	ErrConflict = errors.New("drive conflict")
	// ErrVersionRequired signals that the API requires optimistic if_version for non-person writes.
	ErrVersionRequired = errors.New("drive version required")
	// ErrTooLarge maps Drive 413s or mount file-size ceiling violations.
	ErrTooLarge = errors.New("drive file too large")
)

// ClientConfig configures a hardened HTTP client for Caveman Drive.
type ClientConfig struct {
	// APIURL is the Caveman Cloud origin (HTTPS, or loopback HTTP for local dev).
	APIURL string
	// Token is a Caveman auth token / API key, or a cdrv_... share token.
	Token string
	// Drive is the drive name or UUID (empty when using a share token).
	Drive string
	// HTTP overrides the underlying HTTP client (primarily for tests).
	HTTP *http.Client
}

// DriveFile matches the Drive API's file/folder metadata shape.
type DriveFile struct {
	ID         string    `json:"id"`
	Path       string    `json:"path"`
	Kind       string    `json:"kind"` // "file" | "folder"
	SizeBytes  int64     `json:"size_bytes"`
	Version    int64     `json:"version"`
	MediaType  string    `json:"media_type"`
	Executable bool      `json:"executable"`
	Origin     string    `json:"origin"`
	ModifiedAt time.Time `json:"modified_at"`
}

// DriveShareMeta describes a share token's scope from GET /api/v1/code/share.
type DriveShareMeta struct {
	Read      bool      `json:"read"`
	Write     bool      `json:"write"`
	ExpiresAt time.Time `json:"expires_at"`
	Label     string    `json:"label"`
}

// DriveClient speaks Caveman Drive's HTTP API for both org drives and share tokens.
type DriveClient struct {
	baseURL  string
	token    string
	drive    string
	shared   bool
	keyedAPI bool
	http     *http.Client
}

// NewDriveClient validates configuration and returns a DriveClient that never
// follows redirects and never leaks tokens or raw terminal escapes in errors.
func NewDriveClient(cfg ClientConfig) (*DriveClient, error) {
	rawURL := strings.TrimSpace(cfg.APIURL)
	if rawURL == "" {
		rawURL = DefaultAPIURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || !u.IsAbs() || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("api_url must be a clean absolute https URL (or loopback http)")
	}
	if u.Scheme != "https" {
		if !(u.Scheme == "http" && isLoopbackHost(u.Hostname())) {
			return nil, errors.New("api_url must use https unless targeting loopback")
		}
	}
	tok := strings.TrimSpace(cfg.Token)
	if tok == "" {
		return nil, errors.New("caveman token is required")
	}
	shared := strings.HasPrefix(tok, ShareTokenPrefix)
	keyed := shared || strings.HasPrefix(tok, "cave_")
	drive := strings.TrimSpace(cfg.Drive)
	if !shared && drive == "" {
		return nil, errors.New("drive name or id is required unless using a cdrv_ share token")
	}
	if shared && drive != "" {
		return nil, errors.New("share tokens are scoped to a single folder and do not take a drive name")
	}
	hc := cfg.HTTP
	if hc == nil {
		// Use dial/header/idle timeouts rather than a short flat Client.Timeout so
		// large (up to 256 MiB) streaming transfers on slow links do not abort mid-stream.
		tr := &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConnsPerHost:   8,
		}
		hc = &http.Client{
			Transport: tr,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &DriveClient{
		baseURL:  strings.TrimRight(rawURL, "/"),
		token:    tok,
		drive:    drive,
		shared:   shared,
		keyedAPI: keyed,
		http:     hc,
	}, nil
}

// IsShared reports whether the client authenticates with a folder share token.
func (c *DriveClient) IsShared() bool { return c.shared }

// RequiresOptimisticVersion reports whether the credential requires if_version
// / if_absent instead of overwrite=true on Caveman Drive.
func (c *DriveClient) RequiresOptimisticVersion() bool { return c.keyedAPI }

func (c *DriveClient) mountPrefix() string {
	if c.shared {
		return "/api/v1/code/share"
	}
	return "/api/v1/code/drives/" + url.PathEscape(c.drive)
}

func (c *DriveClient) redact(s string) string {
	if c.token != "" {
		s = strings.ReplaceAll(s, c.token, "[redacted]")
	}
	return SanitizeTerminalText(s)
}

func (c *DriveClient) newRequest(ctx context.Context, method, relPath string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+relPath, body)
	if err != nil {
		return nil, errors.New(c.redact(err.Error()))
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", "caveman-drive-mount/1.0")
	return req, nil
}

func (c *DriveClient) mapError(status int, body []byte) error {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &env)
	code := c.redact(env.Error.Code)
	msg := c.redact(env.Error.Message)
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d", status)
	}
	if code == "cave_code_drive_version_required" {
		return fmt.Errorf("%w: %s", ErrVersionRequired, msg)
	}
	switch status {
	case http.StatusNotFound:
		return fmt.Errorf("%w: %s", ErrNotFound, msg)
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: %s", ErrPermission, msg)
	case http.StatusConflict, http.StatusPreconditionFailed:
		return fmt.Errorf("%w: %s", ErrConflict, msg)
	case http.StatusRequestEntityTooLarge:
		return fmt.Errorf("%w: %s", ErrTooLarge, msg)
	default:
		return fmt.Errorf("drive API error (%d %s): %s", status, code, msg)
	}
}

func (c *DriveClient) doJSON(ctx context.Context, method, relPath string, in any, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := c.newRequest(ctx, method, relPath, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New(c.redact(err.Error()))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONReplyBytes+1))
	if err != nil {
		return errors.New(c.redact(err.Error()))
	}
	if int64(len(raw)) > maxJSONReplyBytes {
		return errors.New("drive API JSON reply exceeded limit")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return c.mapError(resp.StatusCode, raw)
	}
	if out != nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("invalid drive API JSON: %w", err)
		}
	}
	return nil
}

// Probe verifies credentials and connectivity against the Drive API.
func (c *DriveClient) Probe(ctx context.Context) (*DriveShareMeta, error) {
	if c.shared {
		var meta DriveShareMeta
		if err := c.doJSON(ctx, http.MethodGet, c.mountPrefix(), nil, &meta); err != nil {
			return nil, err
		}
		return &meta, nil
	}
	var out struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.doJSON(ctx, http.MethodGet, c.mountPrefix(), nil, &out); err != nil {
		return nil, err
	}
	return nil, nil
}

// ListFiles lists immediate children (or recursive descendants) under drivePath
// with strict page and entry bounds against malicious/runaway pagination.
func (c *DriveClient) ListFiles(ctx context.Context, drivePath string, recursive bool) ([]DriveFile, error) {
	var all []DriveFile
	cursor := ""
	seen := map[string]bool{}
	for pages := 0; pages < maxListPages; pages++ {
		q := url.Values{}
		if drivePath != "" && drivePath != "/" {
			q.Set("path", drivePath)
		}
		if recursive {
			q.Set("recursive", "true")
		}
		q.Set("limit", "1000")
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var page struct {
			Files      []DriveFile `json:"files"`
			NextCursor string      `json:"next_cursor"`
		}
		if err := c.doJSON(ctx, http.MethodGet, c.mountPrefix()+"/files?"+q.Encode(), nil, &page); err != nil {
			return nil, err
		}
		if len(all)+len(page.Files) > maxListEntries {
			return nil, errors.New("drive listing exceeded maximum entry limit")
		}
		all = append(all, page.Files...)
		if page.NextCursor == "" {
			return all, nil
		}
		if seen[page.NextCursor] {
			return nil, errors.New("drive listing returned repeated cursor")
		}
		seen[page.NextCursor] = true
		cursor = page.NextCursor
	}
	return nil, errors.New("drive listing exceeded maximum page limit")
}

// Download streams a file's raw bytes from the Drive API into dst.
func (c *DriveClient) Download(ctx context.Context, drivePath string, dst io.Writer) (int64, int64, error) {
	q := url.Values{}
	q.Set("path", drivePath)
	req, err := c.newRequest(ctx, http.MethodGet, c.mountPrefix()+"/content?"+q.Encode(), nil)
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, 0, errors.New(c.redact(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return 0, 0, c.mapError(resp.StatusCode, raw)
	}
	n, err := io.Copy(dst, io.LimitReader(resp.Body, MaxMountFileBytes+1))
	if err != nil {
		return n, 0, errors.New(c.redact(err.Error()))
	}
	if n > MaxMountFileBytes {
		return n, 0, ErrTooLarge
	}
	etag := strings.Trim(resp.Header.Get("ETag"), "\"")
	ver, _ := strconv.ParseInt(etag, 10, 64)
	return n, ver, nil
}

// UploadOptions selects optimistic concurrency mode for PUT /content.
type UploadOptions struct {
	IfVersion int64
	IfAbsent  bool
	Overwrite bool
}

// Upload writes a file's bytes via PUT /content.
func (c *DriveClient) Upload(ctx context.Context, drivePath string, body io.Reader, size int64, opt UploadOptions) (DriveFile, error) {
	if size < 0 || size > MaxMountFileBytes {
		return DriveFile{}, ErrTooLarge
	}
	q := url.Values{}
	q.Set("path", drivePath)
	switch {
	case opt.IfVersion > 0:
		q.Set("if_version", strconv.FormatInt(opt.IfVersion, 10))
	case opt.IfAbsent:
		q.Set("if_absent", "true")
	case opt.Overwrite:
		q.Set("overwrite", "true")
	}
	req, err := c.newRequest(ctx, http.MethodPut, c.mountPrefix()+"/content?"+q.Encode(), body)
	if err != nil {
		return DriveFile{}, err
	}
	req.ContentLength = size
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return DriveFile{}, errors.New(c.redact(err.Error()))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONReplyBytes+1))
	if err != nil {
		return DriveFile{}, errors.New(c.redact(err.Error()))
	}
	if int64(len(raw)) > maxJSONReplyBytes {
		return DriveFile{}, errors.New("drive upload response exceeded limit")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return DriveFile{}, c.mapError(resp.StatusCode, raw)
	}
	var out struct {
		File DriveFile `json:"file"`
	}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			return DriveFile{}, fmt.Errorf("invalid drive upload JSON: %w", err)
		}
	}
	return out.File, nil
}

// Move renames or moves a file or folder inside the drive.
func (c *DriveClient) Move(ctx context.Context, fromPath, toPath string) error {
	return c.doJSON(ctx, http.MethodPost, c.mountPrefix()+"/move", map[string]string{
		"from": fromPath,
		"to":   toPath,
	}, nil)
}

// Delete removes a file or folder (recursively when requested).
func (c *DriveClient) Delete(ctx context.Context, drivePath string, recursive bool) error {
	payload := map[string]any{"path": drivePath}
	if recursive {
		payload["recursive"] = true
	}
	return c.doJSON(ctx, http.MethodPost, c.mountPrefix()+"/delete", payload, nil)
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
