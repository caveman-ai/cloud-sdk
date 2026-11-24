package cavemancloud

// Sandboxes: computers made and used from outside them, the API's /code/computers, for an
// organization's code:run key (a sandbox is a computer as the console shows it). The plain calls
// (List, Create, Get, Sleep, Resume, Delete) and the wire types are generated from the contract
// (sandboxes_generated.go, scripts/generate-cloud-sdk.mjs); this file is what a generator does not
// do well: the transport with its retries and typed errors, a command's stream into a sandbox (a
// WebSocket on the relay, subprotocol caveman.computer.v1), and waiting for a state (the API holds a
// read until the state, GET's wait_for; a Caveman Cloud that does not is polled).
//
// The key decides everything: the organization and the service account come from it, never from
// a request, and a key sees only the sandboxes its service account made.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SandboxesOptions configures a Sandboxes client.
type SandboxesOptions struct {
	// ControlURL is the Cloud API origin, such as https://app.caveman.so.
	ControlURL string
	// APIKey is an organization's code:run key (cave_live_...): it acts as its service account.
	APIKey string
	// RelayURL is the origin that serves /relay (a command's stream); empty, ControlURL.
	RelayURL string
	// Timeout bounds each call; zero, 30 seconds. A command's stream has no timeout of its own: its
	// context ends it.
	Timeout time.Duration
	// Transport carries every request and stream; nil, http.DefaultTransport.
	Transport http.RoundTripper
	// Retries is how many more times a call is made when the API says it may be asked again
	// (below); zero, 3; negative, never.
	Retries int
}

// Sandboxes makes, runs commands in, and puts away sandboxes.
type Sandboxes struct {
	endpoint, relay, key string
	http, stream         *http.Client
	retries              int
	pause                func(context.Context, time.Duration) error
	poll                 time.Duration
}

// NewSandboxes checks the options and returns a client. Plain HTTP is refused except to this machine.
func NewSandboxes(options SandboxesOptions) (*Sandboxes, error) {
	endpoint, err := sandboxOrigin(options.ControlURL)
	if err != nil {
		return nil, err
	}
	relay := endpoint
	if options.RelayURL != "" {
		if relay, err = sandboxOrigin(options.RelayURL); err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(options.APIKey) == "" {
		return nil, &Error{Code: "cave_auth_required", Message: "A code:run key is required."}
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	retries := options.Retries
	switch {
	case retries == 0:
		retries = 3
	case retries < 0:
		retries = 0
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Sandboxes{endpoint: endpoint + "/api/v1", relay: relay, key: options.APIKey, retries: retries, poll: time.Second,
		http:   &http.Client{Timeout: timeout, Transport: options.Transport, CheckRedirect: noRedirect},
		stream: &http.Client{Transport: options.Transport, CheckRedirect: noRedirect},
		pause:  sleepContext}, nil
}

func sandboxOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" || strings.Trim(u.Path, "/") != "" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
		return "", &Error{Code: "cave_endpoint_invalid", Message: "Use an HTTPS origin, or HTTP on this machine, with no path, credentials, query or fragment."}
	}
	return u.Scheme + "://" + u.Host, nil
}

func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// IsSandboxLimit reports whether err is a limit reached on making or waking a sandbox (a code of
// the cave_code_computer_limit_ family): the plan's size, awake memory or kept sandboxes, or the
// installation's limits per person, service account or organization.
func IsSandboxLimit(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	for _, prefix := range SandboxErrorPrefixes {
		if strings.HasPrefix(e.Code, prefix) {
			return true
		}
	}
	return false
}

// send makes one call of route, again while the API says it may be asked again: a GET (safe) after
// a dropped connection or a 502, 503 or 504; any call refused with 429 (the server did nothing); a
// call refused with one of the route's retryOn codes (DELETE's cave_code_computer_busy). A
// Retry-After is waited for, up to sandboxMaxRetryWait; one longer is answered at once, its seconds
// on the error (Error.RetryAfter), for the caller to decide. Nothing else is repeated: a create
// whose answer was lost is not made twice.
func (s *Sandboxes) send(ctx context.Context, route sandboxRoute, path string, query url.Values, body, out any) error {
	_, err := s.request(ctx, s.http, route, path, query, body, out)
	return err
}

// request is send through client, answering the response's headers too.
func (s *Sandboxes) request(ctx context.Context, client *http.Client, route sandboxRoute, path string, query url.Values, body, out any) (http.Header, error) {
	target := s.endpoint + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	for attempt := 0; ; attempt++ {
		status, header, data, err := s.once(ctx, client, route.method, target, raw, body != nil)
		var failure error
		switch {
		case err != nil:
			failure = err
		case status < 200 || status > 299:
			failure = sandboxFailure(status, header, data)
		default:
			if status == http.StatusNoContent || out == nil {
				return header, nil
			}
			if err := json.Unmarshal(data, out); err != nil {
				return header, &Error{Code: "cave_response_invalid", Message: "The response is not the documented JSON.", Status: status}
			}
			return header, nil
		}
		wait, again := sandboxRetry(route, status, header, failure, attempt)
		if !again || attempt >= s.retries || ctx.Err() != nil {
			return nil, failure
		}
		if err := s.pause(ctx, wait); err != nil {
			return nil, failure
		}
	}
}

func (s *Sandboxes) once(ctx context.Context, client *http.Client, method, target string, raw []byte, hasBody bool) (int, http.Header, []byte, error) {
	var reader io.Reader
	if hasBody {
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+s.key)
	request.Header.Set("Accept", "application/json")
	if hasBody {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil {
		return 0, nil, nil, err
	}
	if len(data) > responseLimit {
		return 0, nil, nil, &Error{Code: "cave_response_too_large", Message: "The response is larger than this SDK reads.", Status: response.StatusCode}
	}
	return response.StatusCode, response.Header, data, nil
}

// sandboxFailure reads the API's error envelope into an *Error.
func sandboxFailure(status int, header http.Header, body []byte) error {
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	e := &Error{Code: envelope.Error.Code, Message: envelope.Error.Message, Status: status, RequestID: envelope.Error.RequestID}
	if e.Code == "" {
		e.Code, e.Message = "cave_request_failed", fmt.Sprintf("Request failed (%d).", status)
	}
	if e.Code == "cave_method_not_allowed" || status == http.StatusMethodNotAllowed {
		// The route is not served: this Caveman Cloud does not offer sandboxes through its API.
		e.Message = strings.TrimSpace(e.Message + " This Caveman Cloud does not offer sandboxes through its API (computers.api.enabled is off).")
	}
	if e.RequestID == "" && header != nil {
		e.RequestID = header.Get("X-Cave-Request-Id")
	}
	if seconds, ok := retryAfterSeconds(header); ok {
		e.RetryAfter = &seconds
	}
	return e
}

// sandboxMaxRetryWait is the longest this client waits before asking again: a Retry-After past it
// (an organization's start ceiling names up to a day) is the caller's to wait out, not a retry's.
const sandboxMaxRetryWait = 30 * time.Second

// retryAfterSeconds is an answer's Retry-After in whole seconds, when it names them.
func retryAfterSeconds(header http.Header) (int, bool) {
	if header == nil {
		return 0, false
	}
	seconds, err := strconv.Atoi(header.Get("Retry-After"))
	return seconds, err == nil && seconds >= 0
}

func sandboxRetry(route sandboxRoute, status int, header http.Header, failure error, attempt int) (time.Duration, bool) {
	wait := time.Duration(250<<min(attempt, 4)) * time.Millisecond
	if seconds, ok := retryAfterSeconds(header); ok {
		if seconds > int(sandboxMaxRetryWait/time.Second) {
			return 0, false
		}
		wait = time.Duration(seconds) * time.Second
	}
	var e *Error
	switch {
	case status == 0:
		// A transport failure: the request may or may not have been acted on. An *Error here is this
		// client's own refusal of the answer (too large), which asking again does not change.
		if errors.As(failure, &e) {
			return 0, false
		}
		return wait, route.safe
	case status == http.StatusTooManyRequests:
		return wait, true
	case status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout:
		return wait, route.safe
	case errors.As(failure, &e):
		for _, code := range route.retryOn {
			if e.Code == code {
				return wait, true
			}
		}
	}
	return 0, false
}

// SandboxStateError is a wait that cannot end in the state it waits for: the sandbox failed, its
// reason needs the caller (ReasonCode is one whose wait ends: ended, out_of_memory, disk_lost, ...),
// or it is asked to be something else.
type SandboxStateError struct {
	SandboxID, Want, Observed, Desired, Reason, ReasonCode string
}

func (e *SandboxStateError) Error() string {
	switch {
	case e.Observed == SandboxStateFailed:
		return fmt.Sprintf("sandbox %s failed: %s", e.SandboxID, e.Reason)
	case sandboxWaitEnds(e.Observed, e.ReasonCode):
		return fmt.Sprintf("sandbox %s is %s: %s", e.SandboxID, e.Observed, e.Reason)
	default:
		return fmt.Sprintf("sandbox %s is asked to be %s, so it will not be %s", e.SandboxID, e.Desired, e.Want)
	}
}

// maxWaitSeconds is how long the API holds one waiting read at most (GET /code/computers/{id}'s
// timeout); waitHeader the header it says how the wait ended in, which a Caveman Cloud that does not
// wait never sends.
const (
	maxWaitSeconds = 60
	waitHeader     = "Cave-Wait"
)

// Wait reads a sandbox until it is in state (an observed_state: running, suspended, stopped), and
// answers it then. A sandbox that failed, whose reason needs the caller, or that is asked to be
// something else (put to sleep while waited on to run, for one), ends the wait with a
// *SandboxStateError. A reason that passes by itself (its observed_reason_code:
// SandboxReasonWaitingForCapacity, SandboxReasonHostUnavailable, ...) does not, even while the
// sandbox reads failed. Waiting for deleted ends when the sandbox is gone (not found), answering the
// zero CodeComputer. ctx bounds the wait; with no deadline it is 10 minutes.
//
// The API holds each read until the state, up to a minute (GET's wait_for: one request, however
// long, to its rate limits), and says how the wait ended (Cave-Wait): unreachable ends it, by the
// same reason codes. A Caveman Cloud whose answer says nothing of the wait (no Cave-Wait) does not
// hold it: Wait then reads again, at most 2 s apart, and judges by the reason codes itself. At the
// API's cap on one caller's waits at once, one read is a plain one.
func (s *Sandboxes) Wait(ctx context.Context, sandboxID, state string) (CodeComputer, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
	}
	deadline, _ := ctx.Deadline()
	interval := s.poll / 2
	waits := true // until an answer says the API does not
	for {
		asked := time.Now()
		seconds := min(maxWaitSeconds, int(time.Until(deadline)/time.Second))
		var c CodeComputer
		var err error
		outcome := ""
		if waits && seconds >= 1 {
			outcome, err = s.waitOnce(ctx, sandboxID, state, seconds, &c)
			var e *Error
			switch {
			case errors.As(err, &e) && e.Code == "cave_code_computer_waits_limit":
				c, err = s.Get(ctx, sandboxID)
			case err == nil && outcome == "":
				waits = false
			}
		} else {
			c, err = s.Get(ctx, sandboxID)
		}
		var e *Error
		switch {
		case state == SandboxStateDeleted && errors.As(err, &e) && e.Status == http.StatusNotFound:
			return CodeComputer{}, nil
		case err != nil:
			return c, err
		case c.ObservedState == state:
			return c, nil
		case outcome == "unreachable" || (outcome == "" && sandboxWaitEnds(c.ObservedState, sandboxText(c.ObservedReasonCode))) || !sandboxHeading(c.DesiredState, state):
			return c, &SandboxStateError{SandboxID: sandboxID, Want: state, Observed: c.ObservedState, Desired: c.DesiredState,
				Reason: sandboxText(c.ObservedReason), ReasonCode: sandboxText(c.ObservedReasonCode)}
		case outcome != "" && time.Since(asked) >= time.Second && ctx.Err() == nil:
			continue // the API held the read: ask again at once (an early answer of timeout waits as a poll)
		}
		interval = min(interval*2, 2*s.poll)
		if err := s.pause(ctx, interval); err != nil {
			return c, fmt.Errorf("sandbox %s is %s, not yet %s: %w", sandboxID, c.ObservedState, state, err)
		}
	}
}

// waitOnce asks the API to hold a read of the sandbox until state, at most seconds, into c, and
// answers its Cave-Wait ("" from a Caveman Cloud that does not wait). The call is bounded by the
// wait and a margin, not by the client's per-call Timeout.
func (s *Sandboxes) waitOnce(ctx context.Context, sandboxID, state string, seconds int, c *CodeComputer) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds+15)*time.Second)
	defer cancel()
	query := url.Values{"wait_for": {state}, "timeout": {strconv.Itoa(seconds)}}
	header, err := s.request(ctx, s.stream, sandboxRoutes["get"], "/code/computers/"+url.PathEscape(sandboxID), query, nil, c)
	if err != nil {
		return "", err
	}
	return header.Get(waitHeader), nil
}

// sandboxWaitEnds reports whether a wait ends on a sandbox observed in state with reason code, it not
// being in the state waited for: by the code (sandboxReasonWaits), one that passes by itself never
// (not even while it reads failed), one that needs the caller always; with no code, or one this
// client does not know, once it has failed.
func sandboxWaitEnds(state, code string) bool {
	wait, ok := sandboxReasonWaits[code]
	if !ok {
		wait = "ends_if_failed"
	}
	return wait == "ends" || (wait == "ends_if_failed" && state == SandboxStateFailed)
}

// sandboxHeading reports whether a sandbox asked to be desired can come to observed state want.
func sandboxHeading(desired, want string) bool {
	switch want {
	case SandboxStateRunning:
		return desired == "running"
	case SandboxStateSuspended, SandboxStateStopped:
		return desired == "suspended" || desired == "stopped"
	case SandboxStateDeleted:
		return desired == "deleted"
	}
	return true
}

func sandboxText(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// SandboxExecError is a command's stream that ended without the command's exit code: refused
// before it opened (Status is the HTTP status), or ended by the sandbox or the relay (Code is one of
// SandboxStreamErrors; CloseCode the WebSocket close code when the stream closed without saying;
// RetryAfter the seconds the far end asked to wait before opening the stream again, as a
// Retry-After or an error's retry_after says, nil when it said none).
type SandboxExecError struct {
	Code, Message string
	Status        int
	CloseCode     int
	RetryAfter    *int
}

func (e *SandboxExecError) Error() string { return "sandbox command: " + e.Code + ": " + e.Message }

// ExecOptions are what a command gets besides its argv.
type ExecOptions struct {
	// Stdin is copied to the command until it ends (or fails to read); nil, the command's stdin is
	// closed at once. The copy runs on its own goroutine: a Read that is waiting when Exec returns
	// (os.Stdin's, say) still completes there, and what it read is dropped, so do not read Stdin
	// elsewhere while that may be.
	Stdin io.Reader
	// Stdout and Stderr receive the command's output as it comes; nil discards it. With TTY, the
	// terminal's output, stderr included, comes on Stdout.
	Stdout, Stderr io.Writer
	// TTY runs the command on a terminal; Cols and Rows set its size (each 1 to SandboxMaxTermSize).
	TTY        bool
	Cols, Rows int
	// Env (beside the sandbox's), Cwd (absolute) and User are the command's. A sandbox that takes no
	// options refuses a start that asks for one (cave_code_computer_unsupported).
	Env  map[string]string
	Cwd  string
	User string
	// Control resizes the running command's terminal and sends it signals (SandboxCommand).
	Control *SandboxCommand
	// OnRefused hears a resize or a signal the sandbox did not act on; the command goes on.
	OnRefused func(SandboxRefusal)
}

// SandboxRefusal is a sandbox's answer to a resize or a signal it did not act on: Of is resize or
// signal, Code the API's.
type SandboxRefusal struct {
	Of, Code, Message string
}

// SandboxCommand speaks to a running command (ExecOptions.Control): it resizes its terminal and
// sends its process group a signal. What is asked before the command's stream opens is sent once it
// does; what the sandbox does not act on comes to ExecOptions.OnRefused. One command at a time.
type SandboxCommand struct {
	mu      sync.Mutex
	send    func([]byte) error
	pending [][]byte
}

// Resize asks the command's terminal be cols by rows, each 1 to SandboxMaxTermSize.
func (c *SandboxCommand) Resize(cols, rows int) error {
	if err := checkSize(cols, rows); err != nil {
		return err
	}
	return c.post(map[string]any{"type": SandboxStreamMessageResize, "cols": cols, "rows": rows})
}

// SendSignal sends the command's process group a signal by name (SandboxSignalTerm, or "SIGTERM").
func (c *SandboxCommand) SendSignal(name string) error {
	bare := strings.TrimPrefix(name, "SIG")
	if !slices.Contains(sandboxSignals, bare) {
		return &SandboxExecError{Code: "cave_bad_request", Message: fmt.Sprintf("A command may be sent %s, not %s.", strings.Join(sandboxSignals, ", "), name)}
	}
	return c.post(map[string]any{"type": SandboxStreamMessageSignal, "signal": bare})
}

// sandboxSignals are the signals a stream may send, in the parity file's order.
var sandboxSignals = []string{SandboxSignalInt, SandboxSignalTerm, SandboxSignalHup, SandboxSignalQuit, SandboxSignalKill, SandboxSignalUsr1,
	SandboxSignalUsr2, SandboxSignalWinch, SandboxSignalCont, SandboxSignalStop, SandboxSignalTstp}

func (c *SandboxCommand) post(message map[string]any) error {
	raw, _ := json.Marshal(message)
	c.mu.Lock()
	send := c.send
	if send == nil {
		c.pending = append(c.pending, raw)
	}
	c.mu.Unlock()
	if send == nil {
		return nil
	}
	return send(raw)
}

// bind is the command's open stream (Exec's), what waited sent on it; nil unbinds it.
func (c *SandboxCommand) bind(send func([]byte) error) {
	c.mu.Lock()
	c.send = send
	var pending [][]byte
	if send != nil {
		pending, c.pending = c.pending, nil
	}
	c.mu.Unlock()
	for _, raw := range pending {
		_ = send(raw)
	}
}

func checkSize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > SandboxMaxTermSize || rows > SandboxMaxTermSize {
		return &SandboxExecError{Code: "cave_bad_request", Message: fmt.Sprintf("A terminal's cols and rows are each from 1 to %d.", SandboxMaxTermSize)}
	}
	return nil
}

// checkOptions refuses a command's options as the sandbox would.
func checkOptions(o ExecOptions) error {
	size := 0
	for k, v := range o.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.IndexByte(v, 0) >= 0 {
			return &SandboxExecError{Code: "cave_bad_request", Message: "An environment variable's name is not empty and holds no = or NUL, and its value holds no NUL."}
		}
		size += len(k) + 1 + len(v)
	}
	if len(o.Env) > SandboxMaxEnv || size > SandboxMaxEnvBytes {
		return &SandboxExecError{Code: "cave_bad_request", Message: fmt.Sprintf("A command's environment is at most %d variables and %d bytes.", SandboxMaxEnv, SandboxMaxEnvBytes)}
	}
	if o.Cwd != "" && (!strings.HasPrefix(o.Cwd, "/") || strings.IndexByte(o.Cwd, 0) >= 0) {
		return &SandboxExecError{Code: "cave_bad_request", Message: "Cwd is an absolute path in the sandbox."}
	}
	if o.Cols != 0 || o.Rows != 0 {
		if !o.TTY {
			return &SandboxExecError{Code: "cave_bad_request", Message: "Cols and Rows are a terminal's: ask for TTY."}
		}
		return checkSize(o.Cols, o.Rows)
	}
	return nil
}

// ExecResult is a command run to its end with its output kept.
type ExecResult struct {
	ExitCode       int
	Stdout, Stderr []byte
}

// Run runs argv in a sandbox and keeps its output; stdin may be nil.
func (s *Sandboxes) Run(ctx context.Context, sandboxID string, argv []string, stdin io.Reader) (ExecResult, error) {
	var out, errOut bytes.Buffer
	code, err := s.Exec(ctx, sandboxID, argv, ExecOptions{Stdin: stdin, Stdout: &out, Stderr: &errOut})
	return ExecResult{ExitCode: code, Stdout: out.Bytes(), Stderr: errOut.Bytes()}, err
}

// Exec runs argv in a running sandbox and streams its output; it answers the command's exit code.
// Ending ctx ends the stream, and the sandbox ends the command; options.Control signals it first.
//
// A stream the sandbox says to open again (its host restarting, before the command started:
// cave_code_computer_host_unreachable) is opened again after the wait it asks, at most 5 times
// within 15 s, while nothing of the command came back and its stdin can be sent again (nil, or an
// io.Seeker, sent again from where it was): never a second run of a command.
func (s *Sandboxes) Exec(ctx context.Context, sandboxID string, argv []string, options ExecOptions) (int, error) {
	if err := checkArgv(argv); err != nil {
		return -1, err
	}
	if err := checkOptions(options); err != nil {
		return -1, err
	}
	again, seeker, from := options.Stdin == nil, io.Seeker(nil), int64(0)
	if sk, ok := options.Stdin.(io.Seeker); ok && options.Stdin != nil {
		if at, err := sk.Seek(0, io.SeekCurrent); err == nil {
			again, seeker, from = true, sk, at
		}
	}
	first := time.Now()
	for attempt := 1; ; attempt++ {
		code, heard, pumped, err := s.execOnce(ctx, sandboxID, argv, options)
		wait, ok := streamRetry(err, attempt, first)
		if !ok || !again || heard {
			return code, err
		}
		if seeker != nil {
			<-pumped // the last stream's copy of stdin has stopped reading it
			if _, serr := seeker.Seek(from, io.SeekStart); serr != nil {
				return code, err
			}
		}
		if serr := sleepContext(ctx, wait); serr != nil {
			return -1, serr
		}
	}
}

// streamRetry says whether a stream that ended with err may be opened again (its code one the
// sandbox says to, within sandboxStreamRetry's tries and bound) and after what wait: the far end's
// retry_after, else the default. Whether nothing came back and the input can be sent again is the
// caller's to add.
func streamRetry(err error, attempt int, first time.Time) (time.Duration, bool) {
	var e *SandboxExecError
	if err == nil || !errors.As(err, &e) || !slices.Contains(sandboxStreamRetry.codes, e.Code) || attempt >= sandboxStreamRetry.tries {
		return 0, false
	}
	wait := time.Duration(sandboxStreamRetry.afterSeconds) * time.Second
	if e.RetryAfter != nil {
		wait = time.Duration(max(0, *e.RetryAfter)) * time.Second
	}
	return wait, time.Since(first)+wait <= time.Duration(sandboxStreamRetry.withinMS)*time.Millisecond
}

// execOnce is one stream of Exec: heard says whether any of the command's output came; pumped is
// closed once the stream's copy of stdin has stopped reading it.
func (s *Sandboxes) execOnce(ctx context.Context, sandboxID string, argv []string, options ExecOptions) (code int, heard bool, pumped <-chan struct{}, err error) {
	copied := make(chan struct{})
	pumped = copied
	pumping := false
	defer func() {
		if !pumping {
			close(copied)
		}
	}()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, err := s.open(ctx, streamPath(SandboxStreamPath, sandboxID))
	if err != nil {
		return -1, false, pumped, err
	}
	defer conn.rwc.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.rwc.Close() })
	defer stop()
	start, _ := json.Marshal(struct {
		Type string            `json:"type"`
		Argv []string          `json:"argv"`
		TTY  bool              `json:"tty,omitempty"`
		Env  map[string]string `json:"env,omitempty"`
		Cwd  string            `json:"cwd,omitempty"`
		User string            `json:"user,omitempty"`
		Cols int               `json:"cols,omitempty"`
		Rows int               `json:"rows,omitempty"`
	}{SandboxStreamMessageStart, argv, options.TTY, options.Env, options.Cwd, options.User, options.Cols, options.Rows})
	if err := conn.write(wsText, start); err != nil {
		return -1, false, pumped, s.ended(ctx, err)
	}
	if options.Control != nil {
		// Controls go after the start, each a message of its own.
		options.Control.bind(func(raw []byte) error { return conn.write(wsText, raw) })
		defer options.Control.bind(nil)
	}
	pumping = true
	go func() { conn.pump(options.Stdin); close(copied) }()
	defer close(conn.done)
	for {
		op, data, err := conn.read(1 + SandboxStreamMaxOutput + SandboxStreamMaxControl)
		if err != nil {
			return -1, heard, pumped, s.ended(ctx, err)
		}
		if op == wsBinary {
			if len(data) < 1 {
				return -1, heard, pumped, &SandboxExecError{Code: "cave_bad_request", Message: "The sandbox sent output with no channel."}
			}
			heard = true
			w := options.Stdout
			if data[0] == SandboxStreamChannelStderr {
				w = options.Stderr
			}
			if w != nil && len(data) > 1 {
				if _, err := w.Write(data[1:]); err != nil {
					return -1, heard, pumped, err
				}
			}
			continue
		}
		var m struct {
			Type       string          `json:"type"`
			Code       json.RawMessage `json:"code"`
			Message    string          `json:"message"`
			RetryAfter *int            `json:"retry_after"`
			Of         string          `json:"of"`
		}
		if json.Unmarshal(data, &m) != nil {
			return -1, heard, pumped, &SandboxExecError{Code: "cave_bad_request", Message: "The sandbox sent a message this client cannot read."}
		}
		switch m.Type {
		case SandboxStreamMessageExit:
			var code int
			if err := json.Unmarshal(m.Code, &code); err != nil {
				return -1, heard, pumped, &SandboxExecError{Code: "cave_bad_request", Message: "The sandbox sent an exit with no code."}
			}
			_ = conn.close(1000)
			return code, true, pumped, nil
		case SandboxStreamMessageError:
			var code string
			_ = json.Unmarshal(m.Code, &code)
			return -1, heard, pumped, &SandboxExecError{Code: code, Message: m.Message, RetryAfter: m.RetryAfter}
		case SandboxStreamMessageRefused:
			if options.OnRefused != nil {
				var code string
				_ = json.Unmarshal(m.Code, &code)
				options.OnRefused(SandboxRefusal{Of: m.Of, Code: code, Message: m.Message})
			}
		}
		// A message type this client does not know is a later version's: it is read past.
	}
}

// ended is the error a stream that broke off answers: the close the far end sent, else ctx's end,
// else the transport's error.
func (s *Sandboxes) ended(ctx context.Context, err error) error {
	var closed *wsClosed
	switch {
	case errors.As(err, &closed):
		// The close's reason is the API's code when the far end gave one; else its close code's.
		code := closed.reason
		if !strings.HasPrefix(code, "cave_") {
			code = sandboxCloseCodes[closed.code]
		}
		if code == "" {
			code = "cave_code_computer_stream_ended"
		}
		message := SandboxStreamErrors[code]
		if message == "" {
			message = closed.reason
		}
		return &SandboxExecError{Code: code, Message: message, CloseCode: closed.code}
	case ctx.Err() != nil:
		return ctx.Err()
	}
	return err
}

func checkArgv(argv []string) error {
	if len(argv) == 0 || argv[0] == "" {
		return &SandboxExecError{Code: "cave_bad_request", Message: "Name a command to run."}
	}
	n := 0
	for _, a := range argv {
		n += len(a)
		if strings.IndexByte(a, 0) >= 0 {
			return &SandboxExecError{Code: "cave_bad_request", Message: "A command's arguments cannot hold a NUL byte."}
		}
	}
	if len(argv) > SandboxStreamMaxArgs || n > SandboxStreamMaxArgvBytes {
		return &SandboxExecError{Code: "cave_bad_request", Message: fmt.Sprintf("A command is at most %d arguments and %d bytes.", SandboxStreamMaxArgs, SandboxStreamMaxArgvBytes)}
	}
	return nil
}

// streamPath is a stream's path (SandboxStreamPath, SandboxFilesPath, SandboxDialPath) for a sandbox.
func streamPath(template, sandboxID string) string {
	return strings.Replace(template, "{computerId}", url.PathEscape(sandboxID), 1)
}

// open upgrades GET <relay><path> (a stream's: exec, files, dial) to a WebSocket on the stream's
// subprotocol, the key as the bearer. A refusal before the upgrade is a *SandboxExecError with the
// HTTP status: the sandbox service's own code when it said one, else the status's.
func (s *Sandboxes) open(ctx context.Context, path string) (*wsConn, error) {
	target := s.relay + path
	// The request's context is the stream's (the caller's, ended when Exec returns); the upgrade alone
	// is bounded, by a timer that stops once the relay answers.
	octx, cancel := context.WithCancel(ctx)
	opening := time.AfterFunc(30*time.Second, cancel)
	defer func() {
		if !opening.Stop() {
			cancel()
		}
	}()
	request, err := http.NewRequestWithContext(octx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	key := base64.StdEncoding.EncodeToString(nonce[:])
	request.Header.Set("Authorization", "Bearer "+s.key)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", key)
	request.Header.Set("Sec-WebSocket-Protocol", SandboxStreamSubprotocol)
	response, err := s.stream.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, SandboxStreamMaxControl))
		return nil, streamRefusal(response.StatusCode, response.Header.Get("Retry-After"), body)
	}
	rwc, ok := response.Body.(io.ReadWriteCloser)
	if !ok || !strings.EqualFold(response.Header.Get("Upgrade"), "websocket") ||
		response.Header.Get("Sec-WebSocket-Accept") != wsAccept(key) || response.Header.Get("Sec-WebSocket-Protocol") != SandboxStreamSubprotocol {
		response.Body.Close()
		return nil, &SandboxExecError{Code: "cave_bad_request", Message: "The relay did not open the stream as caveman.computer.v1.", Status: response.StatusCode}
	}
	return &wsConn{rwc: rwc, r: bufio.NewReader(rwc), done: make(chan struct{})}, nil
}

// streamRefusal is a refusal before the upgrade: the API's error envelope the relay answers with,
// else (a proxy's page) a code for the status.
func streamRefusal(status int, retryAfter string, body []byte) error {
	var after *int
	if n, err := strconv.Atoi(retryAfter); err == nil && n >= 0 && len(retryAfter) <= 4 {
		after = &n
	}
	var e struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error.Code != "" {
		return &SandboxExecError{Code: e.Error.Code, Message: e.Error.Message, Status: status, RetryAfter: after}
	}
	text := strings.TrimSpace(string(body))
	code := map[int]string{401: "cave_unauthorized", 403: "cave_forbidden", 404: "cave_not_found", 429: "cave_rate_limit_exceeded"}[status]
	if code == "" {
		code = "cave_request_failed"
	}
	if status == http.StatusNotFound {
		text = "No such sandbox for this key, or this Caveman Cloud does not offer sandbox commands (computers.api.enabled is off)."
	}
	if text == "" {
		text = fmt.Sprintf("The stream was refused (%d).", status)
	}
	return &SandboxExecError{Code: code, Message: text, Status: status}
}

// The WebSocket of a command's stream (RFC 6455, a client's part): frames masked out, unmasked in,
// no extensions, a message whole once its last fragment came, a ping answered, a close returned.
const (
	wsContinuation = 0x0
	wsText         = 0x1
	wsBinary       = 0x2
	wsClose        = 0x8
	wsPing         = 0x9
	wsPong         = 0xA
)

func wsAccept(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

type wsClosed struct {
	code   int
	reason string
}

func (e *wsClosed) Error() string { return fmt.Sprintf("stream closed (%d %s)", e.code, e.reason) }

type wsConn struct {
	rwc       io.ReadWriteCloser
	r         *bufio.Reader
	mu        sync.Mutex
	closeSent bool
	done      chan struct{} // closed when Exec returns: the pump sends nothing more
}

func (c *wsConn) write(op byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closeSent {
		return io.ErrClosedPipe
	}
	if op == wsClose {
		c.closeSent = true
	}
	return writeFrame(c.rwc, op, payload, true)
}

func (c *wsConn) close(code int) error {
	payload := make([]byte, 2)
	binary.BigEndian.PutUint16(payload, uint16(code))
	return c.write(wsClose, payload)
}

// pump copies stdin to the stream in messages of at most SandboxStreamMaxInput bytes, then says
// stdin ended (also when reading stdin fails: its input ends there). A failed write ends it quietly:
// the read side answers why. Once Exec has returned it sends nothing more; a Read already waiting
// (on os.Stdin, say) still returns its bytes to this goroutine, which drops them.
func (c *wsConn) pump(stdin io.Reader) {
	if stdin != nil {
		buf := make([]byte, SandboxStreamMaxInput)
		for {
			n, err := stdin.Read(buf)
			select {
			case <-c.done:
				return
			default:
			}
			if n > 0 {
				if c.write(wsBinary, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				break
			}
		}
	}
	_ = c.write(wsText, []byte(`{"type":"`+SandboxStreamMessageCloseStdin+`"}`))
}

// read answers the next whole message, answering pings on the way. A close from the far end is a
// *wsClosed, returned once the close is answered.
func (c *wsConn) read(limit int) (byte, []byte, error) {
	var op byte
	var message []byte
	for {
		fin, frameOp, payload, err := readFrame(c.r, limit, false)
		if err != nil {
			return 0, nil, err
		}
		switch frameOp {
		case wsPing:
			// A pong that cannot be written (the connection going) is not the stream's answer: the
			// next read is, a close the far end sent first among them.
			_ = c.write(wsPong, payload)
			continue
		case wsPong:
			continue
		case wsClose:
			closed := &wsClosed{code: 1005}
			if len(payload) >= 2 {
				closed.code, closed.reason = int(binary.BigEndian.Uint16(payload)), string(payload[2:])
			}
			_ = c.close(1000)
			return 0, nil, closed
		case wsContinuation:
			if op == 0 {
				return 0, nil, errors.New("stream: a continuation with no message")
			}
		case wsText, wsBinary:
			if op != 0 {
				return 0, nil, errors.New("stream: a new message inside another")
			}
			op = frameOp
		default:
			return 0, nil, fmt.Errorf("stream: unknown frame %#x", frameOp)
		}
		if len(message)+len(payload) > limit {
			return 0, nil, errors.New("stream: a message over its bound")
		}
		message = append(message, payload...)
		if fin {
			return op, message, nil
		}
	}
}

// writeFrame writes one final frame of op; masked, as a client must.
func writeFrame(w io.Writer, op byte, payload []byte, masked bool) error {
	header := []byte{0x80 | op, 0}
	switch n := len(payload); {
	case n < 126:
		header[1] = byte(n)
	case n <= 0xFFFF:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(n))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(n))
	}
	body := payload
	if masked {
		header[1] |= 0x80
		var mask [4]byte
		_, _ = rand.Read(mask[:])
		header = append(header, mask[:]...)
		body = make([]byte, len(payload))
		for i, b := range payload {
			body[i] = b ^ mask[i%4]
		}
	}
	_, err := w.Write(append(header, body...))
	return err
}

// readFrame reads one frame; masked says whether the far end must mask (a server reads masked
// frames, a client unmasked ones).
func readFrame(r *bufio.Reader, limit int, masked bool) (bool, byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return false, 0, nil, err
	}
	if head[0]&0x70 != 0 {
		return false, 0, nil, errors.New("stream: a frame with reserved bits")
	}
	if (head[1]&0x80 != 0) != masked {
		return false, 0, nil, errors.New("stream: a frame masked the wrong way")
	}
	n := uint64(head[1] & 0x7F)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return false, 0, nil, err
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	if n > uint64(limit) {
		return false, 0, nil, errors.New("stream: a frame over its bound")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return head[0]&0x80 != 0, head[0] & 0x0F, payload, nil
}
