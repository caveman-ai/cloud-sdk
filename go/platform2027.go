package cavemancloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// PlatformOptions configures the Phase 0/1/2 primitive clients (Rooms, Apps,
// Listeners, Workflows, ComputerPools).
type PlatformOptions struct {
	ControlURL string
	APIKey     string
	Timeout    time.Duration
	Retries    int
	RetryDelay time.Duration
	Transport  http.RoundTripper
}

// WorkflowUncertainEffectError is returned fail-closed when an external
// side-effect step crashed mid-flight and requires operator review.
type WorkflowUncertainEffectError struct {
	StepKey string
	Message string
}

func (e *WorkflowUncertainEffectError) Error() string {
	if e.Message != "" {
		return "cave_workflow_uncertain_effect: " + e.Message
	}
	return fmt.Sprintf("cave_workflow_uncertain_effect: step %s crashed mid-external effect; operator review required", e.StepKey)
}

// WorkflowParkedError indicates a workflow run cleanly parked on a durable awakeable.
type WorkflowParkedError struct {
	Wait SessionWait
}

func (e *WorkflowParkedError) Error() string {
	return fmt.Sprintf("cave_workflow_parked: workflow parked waiting on %s (%s)", e.Wait.Kind, e.Wait.ID)
}

type platformTransport struct {
	baseURL    string
	apiKey     string
	retries    int
	retryDelay time.Duration
	http       *http.Client
}

func newPlatformTransport(opts PlatformOptions) (*platformTransport, error) {
	u, err := url.Parse(opts.ControlURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
		return nil, &Error{Code: "cave_endpoint_invalid", Message: "ControlURL must be HTTPS or loopback HTTP without credentials, query, or fragment."}
	}
	if strings.TrimSpace(opts.APIKey) == "" {
		return nil, &Error{Code: "cave_auth_required", Message: "APIKey is required."}
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	if timeout < 100*time.Millisecond || timeout > 120*time.Second {
		return nil, &Error{Code: "cave_timeout_invalid", Message: "Timeout must be 100ms–120s."}
	}
	retries := opts.Retries
	if retries == 0 {
		retries = 2
	}
	if retries < 0 {
		retries = 0
	}
	retryDelay := opts.RetryDelay
	if retryDelay == 0 {
		retryDelay = 250 * time.Millisecond
	}
	return &platformTransport{
		baseURL:    strings.TrimRight(opts.ControlURL, "/"),
		apiKey:     strings.TrimSpace(opts.APIKey),
		retries:    retries,
		retryDelay: retryDelay,
		http: &http.Client{
			Transport: opts.Transport,
			Timeout:   timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return &Error{Code: "cave_redirect_denied", Message: "Cloud redirects are not followed."}
			},
		},
	}, nil
}

func (t *platformTransport) do(ctx context.Context, method, path string, body any, idempotencyKey string, out any) error {
	var encoded []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		if len(b) > responseLimit {
			return &Error{Code: "cave_input_invalid", Message: "Input exceeds 16 MiB."}
		}
		encoded = b
	}
	for attempt := 0; ; attempt++ {
		var r io.Reader
		if encoded != nil {
			r = bytes.NewReader(encoded)
		}
		req, err := http.NewRequestWithContext(ctx, method, t.baseURL+path, r)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+t.apiKey)
		req.Header.Set("X-Cave-Client", "caveman-sdk-go")
		if encoded != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		resp, err := t.http.Do(req)
		if err != nil {
			return err
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
		_ = resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if len(raw) > responseLimit {
			return &Error{Code: "cave_result_too_large", Message: "Result exceeds 16 MiB.", Status: resp.StatusCode}
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if out != nil && len(raw) > 0 {
				if err := json.Unmarshal(raw, out); err != nil {
					return &Error{Code: "cave_invalid_response", Message: "Invalid JSON response.", Status: resp.StatusCode}
				}
			}
			return nil
		}
		var retryAfter *int
		if ra := strings.TrimSpace(resp.Header.Get("Retry-After")); ra != "" {
			if n, err := strconv.Atoi(ra); err == nil && n >= 0 {
				retryAfter = &n
			}
		}
		if (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500) && attempt < t.retries {
			wait := t.retryDelay * time.Duration(1<<attempt)
			if retryAfter != nil {
				wait = time.Duration(*retryAfter) * time.Second
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
			continue
		}
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &envelope)
		code := envelope.Error.Code
		if code == "" {
			code = fmt.Sprintf("http_%d", resp.StatusCode)
		}
		msg := envelope.Error.Message
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return &Error{Code: code, Message: msg, Status: resp.StatusCode, RetryAfter: retryAfter}
	}
}

/* ================================ ROOMS ================================= */

type Room struct {
	ID             string `json:"id"`
	OrganizationID string `json:"organization_id"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Visibility     string `json:"visibility"`
	TaintPolicy    string `json:"taint_policy"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

type CreateRoomInput struct {
	Slug        string `json:"slug"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Visibility  string `json:"visibility,omitempty"`
	TaintPolicy string `json:"taint_policy,omitempty"`
}

type RoomThread struct {
	ID             string   `json:"id"`
	RoomID         string   `json:"room_id"`
	Title          string   `json:"title"`
	Status         string   `json:"status"`
	Labels         []string `json:"labels"`
	DependsOn      []string `json:"depends_on"`
	LeasedByKind   string   `json:"leased_by_kind,omitempty"`
	LeasedByID     string   `json:"leased_by_id,omitempty"`
	LeaseToken     string   `json:"lease_token,omitempty"`
	LeaseExpiresAt string   `json:"lease_expires_at,omitempty"`
	Tainted        bool     `json:"tainted"`
	TaintSources   []string `json:"taint_sources"`
	MessageSeq     int64    `json:"message_seq"`
	CreatedBy      string   `json:"created_by"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

type CreateRoomThreadInput struct {
	Title          string   `json:"title"`
	Body           string   `json:"body,omitempty"`
	Status         string   `json:"status,omitempty"`
	Labels         []string `json:"labels,omitempty"`
	DependsOn      []string `json:"depends_on,omitempty"`
	SessionID      string   `json:"session_id,omitempty"`
	StructuredData any      `json:"structured_data,omitempty"`
	AppRef         any      `json:"app_ref,omitempty"`
	Untrusted      bool     `json:"untrusted,omitempty"`
	TaintSource    string   `json:"taint_source,omitempty"`
}

type RoomMessage struct {
	ID             string `json:"id"`
	RoomID         string `json:"room_id"`
	ThreadID       string `json:"thread_id"`
	Seq            int64  `json:"seq"`
	SenderKind     string `json:"sender_kind"`
	SenderID       string `json:"sender_id"`
	SenderName     string `json:"sender_name,omitempty"`
	SessionID      string `json:"session_id,omitempty"`
	Kind           string `json:"kind"`
	Body           string `json:"body"`
	StructuredData any    `json:"structured_data,omitempty"`
	AppRef         any    `json:"app_ref,omitempty"`
	Tainted        bool   `json:"tainted"`
	TaintSource    string `json:"taint_source,omitempty"`
	CreatedAt      string `json:"created_at"`
}

type PostRoomMessageInput struct {
	Body           string `json:"body"`
	Kind           string `json:"kind,omitempty"`
	SenderName     string `json:"sender_name,omitempty"`
	SessionID      string `json:"session_id,omitempty"`
	StructuredData any    `json:"structured_data,omitempty"`
	AppRef         any    `json:"app_ref,omitempty"`
	Untrusted      bool   `json:"untrusted,omitempty"`
	TaintSource    string `json:"taint_source,omitempty"`
	IdempotencyKey string `json:"-"`
}

type RoomWatcher struct {
	ID          string   `json:"id"`
	RoomID      string   `json:"room_id"`
	ThreadID    string   `json:"thread_id,omitempty"`
	WatcherKind string   `json:"watcher_kind"`
	TargetID    string   `json:"target_id"`
	OnEvents    []string `json:"on_events"`
	Enabled     bool     `json:"enabled"`
}

type CreateRoomWatcherInput struct {
	WatcherKind  string   `json:"watcher_kind"`
	TargetID     string   `json:"target_id"`
	ThreadID     string   `json:"thread_id,omitempty"`
	FilterLabels []string `json:"filter_labels,omitempty"`
	OnEvents     []string `json:"on_events,omitempty"`
}

type RoomThreadRollup struct {
	ThreadID     string   `json:"thread_id"`
	RoomID       string   `json:"room_id"`
	Status       string   `json:"status"`
	Tainted      bool     `json:"tainted"`
	Messages     int      `json:"messages"`
	SessionCount int      `json:"session_count"`
	SessionIDs   []string `json:"session_ids"`
	InputTokens  int64    `json:"input_tokens"`
	OutputTokens int64    `json:"output_tokens"`
	CostUSD      float64  `json:"cost_usd"`
	CostBasis    string   `json:"cost_basis"`
	PullRequests int      `json:"pull_requests"`
}

type RoomLeaseOptions struct {
	TTLSeconds int
	SessionID  string
	RenewEvery time.Duration
}

// Rooms client for decoupled multi-agent conversations, atomic leases, and taint propagation.
type Rooms struct {
	tx *platformTransport
}

func NewRooms(opts PlatformOptions) (*Rooms, error) {
	tx, err := newPlatformTransport(opts)
	if err != nil {
		return nil, err
	}
	return &Rooms{tx: tx}, nil
}

func (r *Rooms) Create(ctx context.Context, input CreateRoomInput) (Room, error) {
	var out Room
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms", input, "", &out)
	return out, err
}

func (r *Rooms) List(ctx context.Context) ([]Room, error) {
	var res struct {
		Rooms []Room `json:"rooms"`
	}
	err := r.tx.do(ctx, http.MethodGet, "/api/v1/code/rooms", nil, "", &res)
	return res.Rooms, err
}

func (r *Rooms) Get(ctx context.Context, room string) (Room, error) {
	var out Room
	err := r.tx.do(ctx, http.MethodGet, "/api/v1/code/rooms/"+url.PathEscape(room), nil, "", &out)
	return out, err
}

func (r *Rooms) Archive(ctx context.Context, room string) (Room, error) {
	var out Room
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/archive", map[string]any{}, "", &out)
	return out, err
}

func (r *Rooms) CreateThread(ctx context.Context, room string, input CreateRoomThreadInput) (RoomThread, *RoomMessage, error) {
	var res struct {
		Thread  RoomThread   `json:"thread"`
		Message *RoomMessage `json:"message,omitempty"`
	}
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads", input, "", &res)
	return res.Thread, res.Message, err
}

func (r *Rooms) ListThreads(ctx context.Context, room, status, label string, limit int) ([]RoomThread, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	if label != "" {
		q.Set("label", label)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/api/v1/code/rooms/" + url.PathEscape(room) + "/threads"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res struct {
		Threads []RoomThread `json:"threads"`
	}
	err := r.tx.do(ctx, http.MethodGet, path, nil, "", &res)
	return res.Threads, err
}

func (r *Rooms) Claim(ctx context.Context, room, threadID string, ttlSeconds int, sessionID string) (RoomThread, error) {
	payload := map[string]any{"ttl_seconds": ttlSeconds}
	if sessionID != "" {
		payload["session_id"] = sessionID
	}
	var out RoomThread
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads/"+url.PathEscape(threadID)+"/claim", payload, "", &out)
	return out, err
}

func (r *Rooms) Renew(ctx context.Context, room, threadID, leaseToken string, ttlSeconds int) (RoomThread, error) {
	var out RoomThread
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads/"+url.PathEscape(threadID)+"/renew", map[string]any{
		"lease_token": leaseToken,
		"ttl_seconds": ttlSeconds,
	}, "", &out)
	return out, err
}

func (r *Rooms) Release(ctx context.Context, room, threadID, leaseToken, note, sessionID string) (RoomThread, error) {
	payload := map[string]any{}
	if leaseToken != "" {
		payload["lease_token"] = leaseToken
	}
	if note != "" {
		payload["note"] = note
	}
	if sessionID != "" {
		payload["session_id"] = sessionID
	}
	var out RoomThread
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads/"+url.PathEscape(threadID)+"/release", payload, "", &out)
	return out, err
}

func (r *Rooms) Complete(ctx context.Context, room, threadID, leaseToken, note, sessionID string) (RoomThread, error) {
	payload := map[string]any{}
	if leaseToken != "" {
		payload["lease_token"] = leaseToken
	}
	if note != "" {
		payload["note"] = note
	}
	if sessionID != "" {
		payload["session_id"] = sessionID
	}
	var out RoomThread
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads/"+url.PathEscape(threadID)+"/complete", payload, "", &out)
	return out, err
}

func (r *Rooms) Post(ctx context.Context, room, threadID string, input PostRoomMessageInput) (RoomMessage, error) {
	var out RoomMessage
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads/"+url.PathEscape(threadID)+"/messages", input, input.IdempotencyKey, &out)
	return out, err
}

func (r *Rooms) ListMessages(ctx context.Context, room, threadID string, afterSeq int64, limit int, sessionID string) ([]RoomMessage, bool, error) {
	q := url.Values{}
	if afterSeq > 0 {
		q.Set("after_seq", strconv.FormatInt(afterSeq, 10))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if sessionID != "" {
		q.Set("session_id", sessionID)
	}
	path := "/api/v1/code/rooms/" + url.PathEscape(room) + "/threads/" + url.PathEscape(threadID) + "/messages"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res struct {
		Messages []RoomMessage `json:"messages"`
		Tainted  bool          `json:"tainted"`
	}
	err := r.tx.do(ctx, http.MethodGet, path, nil, "", &res)
	return res.Messages, res.Tainted, err
}

func (r *Rooms) Wait(ctx context.Context, room, threadID string, afterSeq int64, timeoutSec int, sessionID string) ([]RoomMessage, bool, bool, error) {
	q := url.Values{}
	if afterSeq > 0 {
		q.Set("after_seq", strconv.FormatInt(afterSeq, 10))
	}
	if timeoutSec > 0 {
		q.Set("timeout", strconv.Itoa(timeoutSec))
	}
	if sessionID != "" {
		q.Set("session_id", sessionID)
	}
	path := "/api/v1/code/rooms/" + url.PathEscape(room) + "/threads/" + url.PathEscape(threadID) + "/wait"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var res struct {
		Messages []RoomMessage `json:"messages"`
		Tainted  bool          `json:"tainted"`
		TimedOut bool          `json:"timed_out"`
	}
	err := r.tx.do(ctx, http.MethodGet, path, nil, "", &res)
	return res.Messages, res.Tainted, res.TimedOut, err
}

func (r *Rooms) Watch(ctx context.Context, room string, input CreateRoomWatcherInput) (RoomWatcher, error) {
	var out RoomWatcher
	err := r.tx.do(ctx, http.MethodPost, "/api/v1/code/rooms/"+url.PathEscape(room)+"/watchers", input, "", &out)
	return out, err
}

func (r *Rooms) Rollup(ctx context.Context, room, threadID string) (RoomThreadRollup, error) {
	var out RoomThreadRollup
	err := r.tx.do(ctx, http.MethodGet, "/api/v1/code/rooms/"+url.PathEscape(room)+"/threads/"+url.PathEscape(threadID)+"/rollup", nil, "", &out)
	return out, err
}

// WithLease atomically claims a task thread, heartbeat-renews the lease while
// fn executes, marks it completed on nil error, or releases it back to ready on error.
func (r *Rooms) WithLease(ctx context.Context, room, threadID string, opts RoomLeaseOptions, fn func(context.Context, RoomThread) error) error {
	ttl := opts.TTLSeconds
	if ttl <= 0 {
		ttl = 300
	}
	claimed, err := r.Claim(ctx, room, threadID, ttl, opts.SessionID)
	if err != nil {
		return err
	}
	renewEvery := opts.RenewEvery
	if renewEvery <= 0 {
		renewEvery = max(5*time.Second, time.Duration(ttl)*time.Second/2)
	}
	hbCtx, cancelHB := context.WithCancel(ctx)
	doneHB := make(chan struct{})
	go func() {
		defer close(doneHB)
		ticker := time.NewTicker(renewEvery)
		defer ticker.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-ticker.C:
				_, _ = r.Renew(hbCtx, room, threadID, claimed.LeaseToken, ttl)
			}
		}
	}()

	runErr := fn(ctx, claimed)
	cancelHB()
	<-doneHB

	if runErr != nil {
		_, _ = r.Release(context.Background(), room, threadID, claimed.LeaseToken, runErr.Error(), opts.SessionID)
		return runErr
	}
	_, err = r.Complete(ctx, room, threadID, claimed.LeaseToken, "", opts.SessionID)
	return err
}

/* ================================= APPS ================================= */

type AppManifest struct {
	Scopes       []string `json:"scopes,omitempty"`
	DrivePaths   []string `json:"drive_paths,omitempty"`
	Deployments  []string `json:"deployments,omitempty"`
	Rooms        []string `json:"rooms,omitempty"`
	DefaultTitle string   `json:"default_title,omitempty"`
	Height       int      `json:"height,omitempty"`
}

type TenantApp struct {
	ID          string      `json:"id"`
	Slug        string      `json:"slug"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Kind        string      `json:"kind"`
	DriveID     string      `json:"drive_id,omitempty"`
	DriveFolder string      `json:"drive_folder,omitempty"`
	EntryFile   string      `json:"entry_file"`
	Visibility  string      `json:"visibility"`
	Manifest    AppManifest `json:"manifest"`
	RenderPath  string      `json:"render_path"`
}

type CreateAppInput struct {
	Slug        string       `json:"slug"`
	Name        string       `json:"name,omitempty"`
	Description string       `json:"description,omitempty"`
	Kind        string       `json:"kind"`
	Drive       string       `json:"drive,omitempty"`
	DriveFolder string       `json:"drive_folder,omitempty"`
	EntryFile   string       `json:"entry_file,omitempty"`
	ComputerID  string       `json:"computer_id,omitempty"`
	Port        int          `json:"port,omitempty"`
	Visibility  string       `json:"visibility,omitempty"`
	Manifest    *AppManifest `json:"manifest,omitempty"`
}

type ForkAppInput struct {
	Slug        string `json:"slug"`
	Name        string `json:"name,omitempty"`
	DriveName   string `json:"drive_name,omitempty"`
	Description string `json:"description,omitempty"`
}

type IssueAppTokenInput struct {
	TTLSeconds   int      `json:"ttl_seconds,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`
	InboxItemID  string   `json:"inbox_item_id,omitempty"`
	RoomThreadID string   `json:"room_thread_id,omitempty"`
}

type AppTokenIssued struct {
	TokenID   string   `json:"token_id"`
	AppID     string   `json:"app_id"`
	Token     string   `json:"token"`
	Scopes    []string `json:"scopes"`
	RenderURL string   `json:"render_url"`
	ExpiresAt string   `json:"expires_at"`
}

// Apps client manages forkable Drive-backed and Sandbox-backed tenant Apps.
type Apps struct {
	tx *platformTransport
}

func NewApps(opts PlatformOptions) (*Apps, error) {
	tx, err := newPlatformTransport(opts)
	if err != nil {
		return nil, err
	}
	return &Apps{tx: tx}, nil
}

func (a *Apps) Create(ctx context.Context, input CreateAppInput) (TenantApp, error) {
	var out TenantApp
	err := a.tx.do(ctx, http.MethodPost, "/api/v1/code/apps", input, "", &out)
	return out, err
}

func (a *Apps) List(ctx context.Context) ([]TenantApp, error) {
	var res struct {
		Apps []TenantApp `json:"apps"`
	}
	err := a.tx.do(ctx, http.MethodGet, "/api/v1/code/apps", nil, "", &res)
	return res.Apps, err
}

func (a *Apps) Get(ctx context.Context, app string) (TenantApp, error) {
	var out TenantApp
	err := a.tx.do(ctx, http.MethodGet, "/api/v1/code/apps/"+url.PathEscape(app), nil, "", &out)
	return out, err
}

func (a *Apps) Fork(ctx context.Context, app string, input ForkAppInput) (TenantApp, error) {
	var out TenantApp
	err := a.tx.do(ctx, http.MethodPost, "/api/v1/code/apps/"+url.PathEscape(app)+"/fork", input, "", &out)
	return out, err
}

func (a *Apps) IssueToken(ctx context.Context, app string, input IssueAppTokenInput) (AppTokenIssued, error) {
	var out AppTokenIssued
	err := a.tx.do(ctx, http.MethodPost, "/api/v1/code/apps/"+url.PathEscape(app)+"/token", input, "", &out)
	return out, err
}

func (a *Apps) Archive(ctx context.Context, app string) (TenantApp, error) {
	var out TenantApp
	err := a.tx.do(ctx, http.MethodPost, "/api/v1/code/apps/"+url.PathEscape(app)+"/archive", map[string]any{}, "", &out)
	return out, err
}

// AppBridge calls the scoped capability bridge for an isolated tenant App.
type AppBridge struct {
	AppID string
	tx    *platformTransport
}

func NewAppBridge(appID string, opts PlatformOptions) (*AppBridge, error) {
	tx, err := newPlatformTransport(opts)
	if err != nil {
		return nil, err
	}
	return &AppBridge{AppID: appID, tx: tx}, nil
}

func (b *AppBridge) DriveRead(ctx context.Context, path string) (string, int, error) {
	var res struct {
		Path    string `json:"path"`
		Text    string `json:"text"`
		Version int    `json:"version"`
	}
	err := b.tx.do(ctx, http.MethodPost, "/api/v1/code/apps/"+url.PathEscape(b.AppID)+"/bridge", map[string]any{
		"action":  "drive.read",
		"payload": map[string]any{"path": path},
	}, "", &res)
	return res.Text, res.Version, err
}

func (b *AppBridge) DriveWrite(ctx context.Context, path, content string) (int, error) {
	var res struct {
		Path    string `json:"path"`
		Version int    `json:"version"`
	}
	err := b.tx.do(ctx, http.MethodPost, "/api/v1/code/apps/"+url.PathEscape(b.AppID)+"/bridge", map[string]any{
		"action":  "drive.write",
		"payload": map[string]any{"path": path, "content": content},
	}, "", &res)
	return res.Version, err
}

func (b *AppBridge) RoomPost(ctx context.Context, room, threadID, body string, structuredData any) (RoomMessage, error) {
	payload := map[string]any{"room": room, "thread_id": threadID, "body": body}
	if structuredData != nil {
		payload["structured_data"] = structuredData
	}
	var res struct {
		Message RoomMessage `json:"message"`
	}
	err := b.tx.do(ctx, http.MethodPost, "/api/v1/code/apps/"+url.PathEscape(b.AppID)+"/bridge", map[string]any{
		"action":  "room.post",
		"payload": payload,
	}, "", &res)
	return res.Message, err
}

/* ============================== LISTENERS =============================== */

type PredicateRule struct {
	Path  string `json:"path"`
	Op    string `json:"op"`
	Value any    `json:"value,omitempty"`
}

type PredicateFilter struct {
	All  []PredicateFilter `json:"all,omitempty"`
	Any  []PredicateFilter `json:"any,omitempty"`
	Not  *PredicateFilter  `json:"not,omitempty"`
	Rule *PredicateRule    `json:"rule,omitempty"`
}

func PredAll(items ...PredicateFilter) PredicateFilter { return PredicateFilter{All: items} }
func PredAny(items ...PredicateFilter) PredicateFilter { return PredicateFilter{Any: items} }
func PredNot(item PredicateFilter) PredicateFilter     { return PredicateFilter{Not: &item} }
func PredEq(path string, value any) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "eq", Value: value}}
}
func PredNeq(path string, value any) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "neq", Value: value}}
}
func PredContains(path, value string) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "contains", Value: value}}
}
func PredIContains(path, value string) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "icontains", Value: value}}
}
func PredPrefix(path, value string) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "prefix", Value: value}}
}
func PredSuffix(path, value string) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "suffix", Value: value}}
}
func PredRegex(path, pattern string) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "regex", Value: pattern}}
}
func PredIn(path string, values []any) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "in", Value: values}}
}
func PredGt(path string, value float64) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "gt", Value: value}}
}
func PredGte(path string, value float64) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "gte", Value: value}}
}
func PredLt(path string, value float64) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "lt", Value: value}}
}
func PredLte(path string, value float64) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "lte", Value: value}}
}
func PredExists(path string, value bool) PredicateFilter {
	return PredicateFilter{Rule: &PredicateRule{Path: path, Op: "exists", Value: value}}
}

type Listener struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	SourceKind    string `json:"source_kind"`
	FilterKind    string `json:"filter_kind"`
	TargetKind    string `json:"target_kind"`
	TargetID      string `json:"target_id"`
	HookID        string `json:"hook_id,omitempty"`
	HookSecret    string `json:"hook_secret,omitempty"`
	EventsSeen    int64  `json:"events_seen"`
	EventsMatched int64  `json:"events_matched"`
	EventsDropped int64  `json:"events_dropped"`
	Enabled       bool   `json:"enabled"`
	ExpiresAt     string `json:"expires_at,omitempty"`
}

type CreateListenerInput struct {
	Name         string         `json:"name"`
	Description  string         `json:"description,omitempty"`
	SourceKind   string         `json:"source_kind"`
	SourceConfig map[string]any `json:"source_config,omitempty"`
	FilterKind   string         `json:"filter_kind,omitempty"`
	FilterSpec   any            `json:"filter_spec,omitempty"`
	TargetKind   string         `json:"target_kind"`
	TargetID     string         `json:"target_id"`
	TargetConfig map[string]any `json:"target_config,omitempty"`
	TTLSeconds   int            `json:"ttl_seconds,omitempty"`
	BudgetUSD    float64        `json:"budget_usd,omitempty"`
}

type ListenerStats struct {
	ListenerID    string  `json:"listener_id"`
	Name          string  `json:"name"`
	EventsSeen    int64   `json:"events_seen"`
	EventsMatched int64   `json:"events_matched"`
	EventsDropped int64   `json:"events_dropped"`
	DropRate      float64 `json:"drop_rate"`
	SpendUSD      float64 `json:"spend_usd"`
	FilterBasis   string  `json:"filter_basis"`
}

type ListenerIngestResult struct {
	Matched            bool   `json:"matched"`
	DispatchedTargetID string `json:"dispatched_target_id,omitempty"`
}

// Listeners manages dynamic TTL-bounded event streams and deterministic filters.
type Listeners struct {
	tx *platformTransport
}

func NewListeners(opts PlatformOptions) (*Listeners, error) {
	tx, err := newPlatformTransport(opts)
	if err != nil {
		return nil, err
	}
	return &Listeners{tx: tx}, nil
}

func (l *Listeners) Create(ctx context.Context, input CreateListenerInput) (Listener, error) {
	var out Listener
	err := l.tx.do(ctx, http.MethodPost, "/api/v1/code/listeners", input, "", &out)
	return out, err
}

func (l *Listeners) List(ctx context.Context) ([]Listener, error) {
	var res struct {
		Listeners []Listener `json:"listeners"`
	}
	err := l.tx.do(ctx, http.MethodGet, "/api/v1/code/listeners", nil, "", &res)
	return res.Listeners, err
}

func (l *Listeners) Get(ctx context.Context, ref string) (Listener, error) {
	var out Listener
	err := l.tx.do(ctx, http.MethodGet, "/api/v1/code/listeners/"+url.PathEscape(ref), nil, "", &out)
	return out, err
}

func (l *Listeners) Pause(ctx context.Context, ref string) (Listener, error) {
	var out Listener
	err := l.tx.do(ctx, http.MethodPost, "/api/v1/code/listeners/"+url.PathEscape(ref)+"/pause", map[string]any{}, "", &out)
	return out, err
}

func (l *Listeners) Resume(ctx context.Context, ref string) (Listener, error) {
	var out Listener
	err := l.tx.do(ctx, http.MethodPost, "/api/v1/code/listeners/"+url.PathEscape(ref)+"/resume", map[string]any{}, "", &out)
	return out, err
}

func (l *Listeners) Delete(ctx context.Context, ref string) error {
	return l.tx.do(ctx, http.MethodDelete, "/api/v1/code/listeners/"+url.PathEscape(ref), nil, "", nil)
}

func (l *Listeners) Ingest(ctx context.Context, ref string, payload any, trusted bool) (ListenerIngestResult, error) {
	path := "/api/v1/code/listeners/" + url.PathEscape(ref) + "/ingest"
	if trusted {
		path += "?trusted=true"
	}
	var out ListenerIngestResult
	err := l.tx.do(ctx, http.MethodPost, path, payload, "", &out)
	return out, err
}

func (l *Listeners) Stats(ctx context.Context, ref string) (ListenerStats, error) {
	var out ListenerStats
	err := l.tx.do(ctx, http.MethodGet, "/api/v1/code/listeners/"+url.PathEscape(ref)+"/stats", nil, "", &out)
	return out, err
}

/* ============================== WORKFLOWS =============================== */

type SessionWait struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Kind      string `json:"kind"`
	AskID     string `json:"ask_id,omitempty"`
	TargetID  string `json:"target_id,omitempty"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

type WorkflowDefinition struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version int    `json:"version"`
	Runtime string `json:"runtime"`
	Digest  string `json:"digest"`
}

type CreateWorkflowInput struct {
	Name        string `json:"name"`
	Runtime     string `json:"runtime"`
	Description string `json:"description,omitempty"`
	SourceDrive string `json:"source_drive,omitempty"`
	SourcePath  string `json:"source_path,omitempty"`
	EntryCode   string `json:"entry_code,omitempty"`
}

type WorkflowRun struct {
	ID           string          `json:"id"`
	WorkflowID   string          `json:"workflow_id"`
	SessionID    string          `json:"session_id"`
	Status       string          `json:"status"`
	Input        json.RawMessage `json:"input,omitempty"`
	Output       json.RawMessage `json:"output,omitempty"`
	ErrorCode    string          `json:"error_code,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
}

type BeginStepInput struct {
	StepKey  string `json:"step_key"`
	ToolName string `json:"tool_name"`
	Effect   string `json:"effect,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Input    any    `json:"input,omitempty"`
}

type BeginStepResponse struct {
	Action       string          `json:"action"`
	StepKey      string          `json:"step_key"`
	Result       json.RawMessage `json:"result,omitempty"`
	ErrorCode    string          `json:"error_code,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
}

type CompleteStepInput struct {
	StepKey      string `json:"step_key"`
	State        string `json:"state,omitempty"`
	Result       any    `json:"result,omitempty"`
	ErrorCode    string `json:"error_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type ParkWaitInput struct {
	Kind      string `json:"kind"`
	AskID     string `json:"ask_id,omitempty"`
	TargetID  string `json:"target_id,omitempty"`
	BarrierID string `json:"barrier_id,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type FinishRunInput struct {
	Status       string `json:"status"`
	Output       any    `json:"output,omitempty"`
	ErrorCode    string `json:"error_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type WorkflowStepOptions struct {
	ToolName string
	Effect   string
	Kind     string
	Input    any
}

// Workflows manages code-first durable workflow definitions, runs, steps, and awakeables.
type Workflows struct {
	tx *platformTransport
}

func NewWorkflows(opts PlatformOptions) (*Workflows, error) {
	tx, err := newPlatformTransport(opts)
	if err != nil {
		return nil, err
	}
	return &Workflows{tx: tx}, nil
}

func (w *Workflows) Create(ctx context.Context, input CreateWorkflowInput) (WorkflowDefinition, error) {
	var out WorkflowDefinition
	err := w.tx.do(ctx, http.MethodPost, "/api/v1/code/workflows", input, "", &out)
	return out, err
}

func (w *Workflows) List(ctx context.Context) ([]WorkflowDefinition, error) {
	var res struct {
		Workflows []WorkflowDefinition `json:"workflows"`
	}
	err := w.tx.do(ctx, http.MethodGet, "/api/v1/code/workflows", nil, "", &res)
	return res.Workflows, err
}

func (w *Workflows) StartRun(ctx context.Context, workflow string, input any, idempotencyKey string) (WorkflowRun, error) {
	payload := map[string]any{}
	if input != nil {
		payload["input"] = input
	}
	if idempotencyKey != "" {
		payload["idempotency_key"] = idempotencyKey
	}
	var out WorkflowRun
	err := w.tx.do(ctx, http.MethodPost, "/api/v1/code/workflows/"+url.PathEscape(workflow)+"/runs", payload, idempotencyKey, &out)
	return out, err
}

func (w *Workflows) GetRun(ctx context.Context, runID string) (WorkflowRun, error) {
	var out WorkflowRun
	err := w.tx.do(ctx, http.MethodGet, "/api/v1/code/workflows/runs/"+url.PathEscape(runID), nil, "", &out)
	return out, err
}

func (w *Workflows) BeginStep(ctx context.Context, runID string, input BeginStepInput) (BeginStepResponse, error) {
	var out BeginStepResponse
	err := w.tx.do(ctx, http.MethodPost, "/api/v1/code/workflows/runs/"+url.PathEscape(runID)+"/steps/begin", input, "", &out)
	return out, err
}

func (w *Workflows) CompleteStep(ctx context.Context, runID string, input CompleteStepInput) error {
	return w.tx.do(ctx, http.MethodPost, "/api/v1/code/workflows/runs/"+url.PathEscape(runID)+"/steps/complete", input, "", nil)
}

func (w *Workflows) ParkWait(ctx context.Context, runID string, input ParkWaitInput) (SessionWait, error) {
	var out SessionWait
	err := w.tx.do(ctx, http.MethodPost, "/api/v1/code/workflows/runs/"+url.PathEscape(runID)+"/wait", input, "", &out)
	return out, err
}

func (w *Workflows) FinishRun(ctx context.Context, runID string, input FinishRunInput) (WorkflowRun, error) {
	var out WorkflowRun
	err := w.tx.do(ctx, http.MethodPost, "/api/v1/code/workflows/runs/"+url.PathEscape(runID)+"/finish", input, "", &out)
	return out, err
}

// WorkflowContext provides replay-safe steps and durable awakeables for a workflow run.
type WorkflowContext struct {
	Workflows *Workflows
	RunID     string
	SessionID string
}

// WorkflowStep runs a durable, replay-safe step backed by code_session_steps.
func WorkflowStep[T any](ctx context.Context, wc *WorkflowContext, stepKey string, opts WorkflowStepOptions, fn func(context.Context) (T, error)) (T, error) {
	var zero T
	toolName := opts.ToolName
	if toolName == "" {
		toolName = stepKey
	}
	effect := opts.Effect
	if effect == "" {
		effect = "idempotent"
	}
	kind := opts.Kind
	if kind == "" {
		kind = "code_tool"
	}
	begun, err := wc.Workflows.BeginStep(ctx, wc.RunID, BeginStepInput{
		StepKey:  stepKey,
		ToolName: toolName,
		Effect:   effect,
		Kind:     kind,
		Input:    opts.Input,
	})
	if err != nil {
		return zero, err
	}
	switch begun.Action {
	case "cached":
		if begun.ErrorCode != "" {
			msg := begun.ErrorMessage
			if msg == "" {
				msg = "Cached step failed."
			}
			return zero, &Error{Code: begun.ErrorCode, Message: msg, Status: 500}
		}
		if len(begun.Result) > 0 && string(begun.Result) != "null" {
			var decoded T
			if err := json.Unmarshal(begun.Result, &decoded); err != nil {
				return zero, err
			}
			return decoded, nil
		}
		return zero, nil
	case "uncertain":
		return zero, &WorkflowUncertainEffectError{StepKey: stepKey}
	}
	val, fnErr := fn(ctx)
	if fnErr != nil {
		_ = wc.Workflows.CompleteStep(context.Background(), wc.RunID, CompleteStepInput{
			StepKey:      stepKey,
			State:        "failed",
			ErrorCode:    "step_error",
			ErrorMessage: fnErr.Error(),
		})
		return zero, fnErr
	}
	if err := wc.Workflows.CompleteStep(ctx, wc.RunID, CompleteStepInput{
		StepKey: stepKey,
		State:   "completed",
		Result:  val,
	}); err != nil {
		return zero, err
	}
	return val, nil
}

// Wait parks the workflow on a durable awakeable and returns *WorkflowParkedError.
func (wc *WorkflowContext) Wait(ctx context.Context, input ParkWaitInput) error {
	waitRow, err := wc.Workflows.ParkWait(ctx, wc.RunID, input)
	if err != nil {
		return err
	}
	return &WorkflowParkedError{Wait: waitRow}
}

// Sleep parks the workflow on a zero-compute durable timer.
func (wc *WorkflowContext) Sleep(ctx context.Context, duration time.Duration, reason string) error {
	if reason == "" {
		reason = "durable sleep"
	}
	return wc.Wait(ctx, ParkWaitInput{
		Kind:      "timer",
		ExpiresAt: time.Now().UTC().Add(duration).Format(time.RFC3339),
		Reason:    reason,
	})
}

// WaitForApproval parks the workflow and files a human Inbox decision item.
func (wc *WorkflowContext) WaitForApproval(ctx context.Context, askID, reason string) error {
	return wc.Wait(ctx, ParkWaitInput{
		Kind:   "approval",
		AskID:  askID,
		Reason: reason,
	})
}

// ExecuteWorkflow starts/resumes a durable workflow run, runs handler with a WorkflowContext,
// and commits completion, parked state, or failure.
func ExecuteWorkflow[I, O any](
	ctx context.Context,
	w *Workflows,
	workflow string,
	input I,
	idempotencyKey string,
	handler func(context.Context, *WorkflowContext, I) (O, error),
) (WorkflowRun, O, *SessionWait, error) {
	var zero O
	run, err := w.StartRun(ctx, workflow, input, idempotencyKey)
	if err != nil {
		return WorkflowRun{}, zero, nil, err
	}
	wc := &WorkflowContext{Workflows: w, RunID: run.ID, SessionID: run.SessionID}
	out, err := handler(ctx, wc, input)
	if err != nil {
		var parked *WorkflowParkedError
		if errors.As(err, &parked) {
			run.Status = "waiting"
			waitCopy := parked.Wait
			return run, zero, &waitCopy, nil
		}
		_, _ = w.FinishRun(context.Background(), run.ID, FinishRunInput{
			Status:       "failed",
			ErrorCode:    "workflow_error",
			ErrorMessage: err.Error(),
		})
		return run, zero, nil, err
	}
	finished, err := w.FinishRun(ctx, run.ID, FinishRunInput{Status: "completed", Output: out})
	return finished, out, nil, err
}

/* =========================== COMPUTER POOLS ============================= */

type ComputerPool struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Size         string `json:"size"`
	Network      string `json:"network"`
	MinWarm      int    `json:"min_warm"`
	MaxSize      int    `json:"max_size"`
	ActiveLeases int    `json:"active_leases"`
}

type CreateComputerPoolInput struct {
	Name        string `json:"name"`
	Size        string `json:"size,omitempty"`
	Network     string `json:"network,omitempty"`
	MinWarm     int    `json:"min_warm,omitempty"`
	MaxSize     int    `json:"max_size,omitempty"`
	Description string `json:"description,omitempty"`
}

type SessionComputerLease struct {
	ID         string `json:"id"`
	SessionID  string `json:"session_id"`
	ComputerID string `json:"computer_id"`
	PoolID     string `json:"pool_id,omitempty"`
	Role       string `json:"role"`
	Label      string `json:"label,omitempty"`
	LeasedAt   string `json:"leased_at"`
}

type LeaseSessionComputerInput struct {
	Pool       string `json:"pool,omitempty"`
	ComputerID string `json:"computer_id,omitempty"`
	Role       string `json:"role,omitempty"`
	Label      string `json:"label,omitempty"`
}

// ComputerPools manages org-wide warm computer pools and N:M session computer leases.
type ComputerPools struct {
	tx *platformTransport
}

func NewComputerPools(opts PlatformOptions) (*ComputerPools, error) {
	tx, err := newPlatformTransport(opts)
	if err != nil {
		return nil, err
	}
	return &ComputerPools{tx: tx}, nil
}

func (p *ComputerPools) Create(ctx context.Context, input CreateComputerPoolInput) (ComputerPool, error) {
	var out ComputerPool
	err := p.tx.do(ctx, http.MethodPost, "/api/v1/code/computer-pools", input, "", &out)
	return out, err
}

func (p *ComputerPools) List(ctx context.Context) ([]ComputerPool, error) {
	var res struct {
		Pools []ComputerPool `json:"pools"`
	}
	err := p.tx.do(ctx, http.MethodGet, "/api/v1/code/computer-pools", nil, "", &res)
	return res.Pools, err
}

func (p *ComputerPools) LeaseForSession(ctx context.Context, sessionID string, input LeaseSessionComputerInput) (SessionComputerLease, error) {
	var out SessionComputerLease
	err := p.tx.do(ctx, http.MethodPost, "/api/v1/code/sessions/"+url.PathEscape(sessionID)+"/computers", input, "", &out)
	return out, err
}

func (p *ComputerPools) ListForSession(ctx context.Context, sessionID string) ([]SessionComputerLease, error) {
	var res struct {
		Computers []SessionComputerLease `json:"computers"`
	}
	err := p.tx.do(ctx, http.MethodGet, "/api/v1/code/sessions/"+url.PathEscape(sessionID)+"/computers", nil, "", &res)
	return res.Computers, err
}

func (p *ComputerPools) ReleaseForSession(ctx context.Context, sessionID, computerID string) error {
	return p.tx.do(ctx, http.MethodDelete, "/api/v1/code/sessions/"+url.PathEscape(sessionID)+"/computers/"+url.PathEscape(computerID), nil, "", nil)
}

func (p *ComputerPools) ListUnified(ctx context.Context, scope string) ([]map[string]any, error) {
	if scope == "" {
		scope = "all"
	}
	var res struct {
		Computers []map[string]any `json:"computers"`
	}
	err := p.tx.do(ctx, http.MethodGet, "/api/v1/code/computers/unified?scope="+url.QueryEscape(scope), nil, "", &res)
	return res.Computers, err
}
