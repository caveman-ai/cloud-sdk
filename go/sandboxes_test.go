package cavemancloud

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// sandboxWire is public/sdk/parity/sandboxes-wire.json: what the branch's handlers, the stream
// endpoint and the relay answered a code:run key (recorded by the Caveman sandbox test harness).
type sandboxWire struct {
	Rest map[string]struct {
		Method, Path string
		Body         json.RawMessage
		Status       int
		Answer       json.RawMessage
	}
	Exec map[string]struct {
		Sandbox string
		Client  []wireFrame
		Server  []wireFrame
		Close   struct {
			Code   int
			Reason string
		}
	}
	Refusals map[string]struct {
		Sandbox     string
		Status      int
		ContentType string `json:"content_type"`
		Body        string
	}
}

type wireFrame struct {
	Text, Stdin, Data, Base64 string
	Channel                   int
}

func loadWire(t *testing.T) sandboxWire {
	t.Helper()
	raw, err := os.ReadFile("../parity/sandboxes-wire.json")
	if err != nil {
		t.Fatal(err)
	}
	var w sandboxWire
	if err := json.Unmarshal(raw, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

// fakeSandboxes serves the recorded wire: each REST call by method and path (its body checked), a
// stream by replaying a recording (the one whose client messages the client sends, or the one named
// in replay), and a refusal before the upgrade for a sandbox named in refusals.
type fakeSandboxes struct {
	t        *testing.T
	w        sandboxWire
	mu       sync.Mutex
	replay   string
	refuse   string
	closeRaw *int // close with this code and no error message
	seen     []string
	used     map[string]bool
	// hostDown streams answer as a computer whose host is restarting does (the lab cannot make one:
	// the service's words, cloud/computers/streams): its error with retryAfter, then close 4503;
	// with hostDownOutput, after some output (the command had started).
	hostDown       int
	retryAfter     int
	hostDownOutput bool
	// files is a sandbox's files, as the files wire answers them (cloud/internal/computerstream
	// files.go): a path to its bytes, or to nil for a folder; fileOps every first message; dialed the
	// ports dialed, portRefused: nothing listens on one.
	files       map[string]*fakeFile
	fileOps     []filesStart
	dialed      []string
	portRefused bool
}

type fakeFile struct {
	dir  bool
	data []byte
	mode uint32
}

func (f *fakeSandboxes) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.seen = append(f.seen, r.Method+" "+r.URL.RequestURI())
	replay, refuse, closeRaw := f.replay, f.refuse, f.closeRaw
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer cave_live_wire" {
		f.t.Errorf("%s %s without the key", r.Method, r.URL)
	}
	if strings.HasPrefix(r.URL.Path, "/relay/v1/computers/") {
		if refuse != "" {
			rf := f.w.Refusals[refuse]
			w.Header().Set("Content-Type", rf.ContentType)
			w.WriteHeader(rf.Status)
			_, _ = io.WriteString(w, rf.Body)
			return
		}
		f.stream(w, r, replay, closeRaw)
		return
	}
	body, _ := io.ReadAll(r.Body)
	// The recordings of one route are answered in the order they were made (a get, then a get
	// after the delete), the last again once all were.
	var match []string
	for _, name := range recorded {
		c := f.w.Rest[name]
		if c.Method == r.Method && c.Path == r.URL.RequestURI() && jsonEqual(c.Body, body) {
			match = append(match, name)
		}
	}
	if len(match) == 0 {
		f.t.Errorf("no recording for %s %s %s", r.Method, r.URL.RequestURI(), body)
		w.WriteHeader(http.StatusTeapot)
		return
	}
	f.mu.Lock()
	if f.used == nil {
		f.used = map[string]bool{}
	}
	name := match[len(match)-1]
	for _, m := range match {
		if !f.used[m] {
			name = m
			break
		}
	}
	f.used[name] = true
	f.mu.Unlock()
	if len(body) > 0 && r.Header.Get("Content-Type") != "application/json" {
		f.t.Errorf("%s %s: content type %q", r.Method, r.URL, r.Header.Get("Content-Type"))
	}
	c := f.w.Rest[name]
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(c.Status)
	_, _ = w.Write(c.Answer)
}

// recorded is the order the lab made its REST recordings in.
var recorded = []string{"create", "get", "list", "list_mine", "get_unknown", "create_bad_size", "create_unknown_field",
	"snapshot", "get_snapshot", "list_snapshots", "get_snapshot_unknown", "snapshot_unknown_field", "restore", "get_snapshot_restored", "fork",
	"delete_snapshot", "delete_snapshot_again", "fork_deleted", "sleep", "resume", "delete", "delete_again", "get_deleted"}

func jsonEqual(a, b []byte) bool {
	if len(bytes.TrimSpace(a)) == 0 || len(bytes.TrimSpace(b)) == 0 {
		return len(bytes.TrimSpace(a)) == len(bytes.TrimSpace(b))
	}
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

// stream answers the upgrade as the relay does and replays a recording.
func (f *fakeSandboxes) stream(w http.ResponseWriter, r *http.Request, replay string, closeRaw *int) {
	if r.Header.Get("Sec-WebSocket-Protocol") != SandboxStreamSubprotocol || r.Header.Get("Sec-WebSocket-Version") != "13" || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		f.t.Errorf("upgrade headers %v", r.Header)
	}
	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		f.t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: %s\r\n\r\n", wsAccept(r.Header.Get("Sec-WebSocket-Key")), SandboxStreamSubprotocol)
	_ = rw.Flush()
	if strings.Contains(r.URL.Path, "/dial/") {
		f.dial(conn, rw, r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:])
		return
	}
	read := func() (byte, []byte) {
		_, op, payload, err := readFrame(rw.Reader, 1<<20, true)
		if err != nil {
			f.t.Errorf("read a client frame: %v", err)
		}
		return op, payload
	}
	op, start := read()
	if op != wsText {
		f.t.Errorf("first frame %d; want the start", op)
	}
	f.mu.Lock()
	down, after, output := f.hostDown > 0, f.retryAfter, f.hostDownOutput
	if down {
		f.hostDown--
	}
	f.mu.Unlock()
	if down {
		const code = "cave_code_computer_host_unreachable"
		if output {
			_ = writeFrame(rw, wsBinary, []byte("\x01started\n"), false)
		}
		_ = writeFrame(rw, wsText, []byte(fmt.Sprintf(`{"type":"error","code":%q,"message":"the computer's host is not answering just now","retry_after":%d}`, code, after)), false)
		_ = writeFrame(rw, wsClose, append(binary.BigEndian.AppendUint16(nil, 4503), code...), false)
		_ = rw.Flush()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		for {
			if _, op, _, err := readFrame(rw.Reader, 1<<20, true); err != nil || op == wsClose {
				return
			}
		}
	}
	if strings.HasSuffix(r.URL.Path, "/files") {
		f.fileOp(conn, rw, start)
		return
	}
	name := replay
	if name == "" {
		for n, rec := range f.w.Exec {
			if len(rec.Client) > 0 && jsonEqual([]byte(rec.Client[0].Text), start) {
				name = n
			}
		}
	}
	rec, ok := f.w.Exec[name]
	if !ok {
		f.t.Errorf("no recording starts %s", start)
		return
	}
	if replay == "" {
		// The client's every later message, as recorded: its stdin, then close_stdin.
		for _, want := range rec.Client[1:] {
			op, payload := read()
			if want.Stdin != "" && (op != wsBinary || string(payload) != want.Stdin) || want.Text != "" && (op != wsText || !jsonEqual([]byte(want.Text), payload)) {
				f.t.Errorf("%s: client sent %d %q; recorded %+v", name, op, payload, want)
			}
		}
	}
	server := rec.Server
	if closeRaw != nil {
		server = nil // a close with nothing before it
	}
	for _, m := range server {
		if m.Text != "" {
			_ = writeFrame(rw, wsText, []byte(m.Text), false)
			continue
		}
		data := []byte(m.Data)
		if m.Base64 != "" {
			data, _ = base64.StdEncoding.DecodeString(m.Base64)
		}
		_ = writeFrame(rw, wsBinary, append([]byte{byte(m.Channel)}, data...), false)
	}
	code, reason := rec.Close.Code, rec.Close.Reason
	if closeRaw != nil {
		code, reason = *closeRaw, ""
	}
	payload := binary.BigEndian.AppendUint16(nil, uint16(code))
	_ = writeFrame(rw, wsClose, append(payload, reason...), false)
	_ = rw.Flush()
	// The client's answer to the close, or its own close after an exit.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, _, _ = readFrame(bufio.NewReader(rw), 1<<20, true)
}

// fileOp answers one file operation as the computers service does.
func (f *fakeSandboxes) fileOp(conn net.Conn, rw *bufio.ReadWriter, start []byte) {
	var op filesStart
	if err := json.Unmarshal(start, &op); err != nil {
		f.t.Errorf("a files stream's first message %s: %v", start, err)
		return
	}
	f.mu.Lock()
	f.fileOps = append(f.fileOps, op)
	if f.files == nil {
		f.files = map[string]*fakeFile{"/": {dir: true}}
	}
	files := f.files
	f.mu.Unlock()
	send := func(v any) { b, _ := json.Marshal(v); _ = writeFrame(rw, wsText, b, false) }
	info := func(p string, file *fakeFile) SandboxFileInfo {
		i := SandboxFileInfo{Name: p[strings.LastIndexByte(p, '/')+1:], Type: SandboxFileTypeFile, Size: int64(len(file.data)), Mode: file.mode, ModTime: "2026-11-20T05:00:00Z"}
		if file.dir {
			i.Type, i.Size = SandboxFileTypeDir, 0
		}
		if i.Mode == 0 {
			i.Mode = map[bool]uint32{true: 0o755, false: 0o644}[file.dir]
		}
		return i
	}
	failed := ""
	fail := func(code, message string) {
		send(map[string]string{"type": "error", "code": code, "message": message})
		failed = code
	}
	parent := op.Path[:max(1, strings.LastIndexByte(op.Path, '/'))]
	f.mu.Lock()
	at := files[op.Path]
	f.mu.Unlock()
	switch op.Op {
	case SandboxFileOpRead:
		if at == nil || at.dir {
			fail(map[bool]string{true: "cave_code_computer_file_refused", false: "cave_code_computer_file_not_found"}[at != nil], "open "+op.Path+": no such file or directory")
			break
		}
		for i := 0; i < len(at.data); i += 5 {
			_ = writeFrame(rw, wsBinary, at.data[i:min(len(at.data), i+5)], false)
		}
		send(map[string]any{"type": "file", "file": info(op.Path, at)})
	case SandboxFileOpWrite:
		var data []byte
		for {
			_, fop, payload, err := readFrame(rw.Reader, 1<<20, true)
			if err != nil {
				f.t.Errorf("a write's data: %v", err)
				return
			}
			if fop == wsBinary {
				data = append(data, payload...)
			} else if fop == wsText && strings.Contains(string(payload), SandboxStreamMessageCloseStdin) {
				break
			}
		}
		f.mu.Lock()
		folder := files[parent]
		if folder != nil && folder.dir {
			files[op.Path] = &fakeFile{data: data, mode: op.Mode}
		}
		written := files[op.Path]
		f.mu.Unlock()
		if folder == nil || !folder.dir {
			fail("cave_code_computer_file_not_found", "open "+op.Path+": no such file or directory")
			break
		}
		send(map[string]any{"type": "file", "file": info(op.Path, written)})
	case SandboxFileOpList:
		if at == nil || !at.dir {
			fail("cave_code_computer_file_not_found", "open "+op.Path+": no such file or directory")
			break
		}
		prefix := strings.TrimSuffix(op.Path, "/") + "/"
		var inside []SandboxFileInfo
		f.mu.Lock()
		for p, file := range files {
			if p != op.Path && strings.HasPrefix(p, prefix) && !strings.Contains(p[len(prefix):], "/") {
				inside = append(inside, info(p, file))
			}
		}
		f.mu.Unlock()
		for i := 0; i < len(inside); i += 2 {
			send(map[string]any{"type": "entries", "entries": inside[i:min(len(inside), i+2)]})
		}
		send(map[string]string{"type": "done"})
	case SandboxFileOpStat:
		if at == nil {
			fail("cave_code_computer_file_not_found", "lstat "+op.Path+": no such file or directory")
			break
		}
		send(map[string]any{"type": "file", "file": info(op.Path, at)})
	case SandboxFileOpMkdir:
		if at != nil {
			fail("cave_code_computer_file_exists", "mkdir "+op.Path+": file exists")
			break
		}
		f.mu.Lock()
		files[op.Path] = &fakeFile{dir: true}
		f.mu.Unlock()
		send(map[string]string{"type": "done"})
	case SandboxFileOpRemove:
		if at == nil {
			fail("cave_code_computer_file_not_found", "remove "+op.Path+": no such file or directory")
			break
		}
		f.mu.Lock()
		for p := range files {
			if p == op.Path || op.All && strings.HasPrefix(p, op.Path+"/") {
				delete(files, p)
			}
		}
		f.mu.Unlock()
		send(map[string]string{"type": "done"})
	case SandboxFileOpRename:
		if at == nil {
			fail("cave_code_computer_file_not_found", "rename "+op.Path+": no such file or directory")
			break
		}
		f.mu.Lock()
		delete(files, op.Path)
		files[op.To] = at
		f.mu.Unlock()
		send(map[string]string{"type": "done"})
	}
	code := map[string]int{"": 1000, "cave_code_computer_file_not_found": 4601, "cave_code_computer_file_exists": 4603, "cave_code_computer_file_refused": 4604}[failed]
	_ = writeFrame(rw, wsClose, append(binary.BigEndian.AppendUint16(nil, uint16(code)), failed...), false)
	_ = rw.Flush()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, op, _, err := readFrame(rw.Reader, 1<<20, true); err != nil || op == wsClose {
			return
		}
	}
}

// dial answers a port that echoes what it is sent, upper-cased, and half-closes when the client
// does; with portRefused, nothing listens.
func (f *fakeSandboxes) dial(conn net.Conn, rw *bufio.ReadWriter, port string) {
	f.mu.Lock()
	f.dialed = append(f.dialed, port)
	refused := f.portRefused
	f.mu.Unlock()
	if refused {
		const code = "cave_code_computer_port_refused"
		_ = writeFrame(rw, wsText, []byte(`{"type":"error","code":"`+code+`","message":"nothing listens on port `+port+`"}`), false)
		_ = writeFrame(rw, wsClose, append(binary.BigEndian.AppendUint16(nil, 4606), code...), false)
		_ = rw.Flush()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	}
	for {
		_, op, payload, err := readFrame(rw.Reader, 1<<20, true)
		if err != nil || op == wsClose {
			return
		}
		if refused {
			continue
		}
		if op == wsBinary {
			_ = writeFrame(rw, wsBinary, bytes.ToUpper(payload), false)
		} else if op == wsText && strings.Contains(string(payload), SandboxStreamMessageCloseWrite) {
			_ = writeFrame(rw, wsText, []byte(`{"type":"close_write"}`), false)
			_ = writeFrame(rw, wsClose, binary.BigEndian.AppendUint16(nil, 1000), false)
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		}
		_ = rw.Flush()
	}
}

// set changes what the fake answers next, under its lock.
func (f *fakeSandboxes) set(replay, refuse string, closeRaw *int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replay, f.refuse, f.closeRaw = replay, refuse, closeRaw
}

// TestAStreamWhoseHostIsRestartingIsOpenedAgain: a stream the sandbox says to open again (its host
// restarting) is opened again after the wait it asks, at most five times, while nothing of the
// command came back and its stdin can be sent again (nil, or a seeker sent again from its start):
// a reader read once, or a command whose output came, is never run a second time.
func TestAStreamWhoseHostIsRestartingIsOpenedAgain(t *testing.T) {
	f, sandboxes, w := newFake(t)
	id := w.Exec["output"].Sandbox
	ctx := context.Background()
	opens := func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		n := 0
		for _, s := range f.seen {
			if strings.HasSuffix(s, "/exec") {
				n++
			}
		}
		return n
	}
	setDown := func(n, after int, output bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.hostDown, f.retryAfter, f.hostDownOutput = n, after, output
	}
	// Twice, then the command runs, its stdin sent again from where it started.
	setDown(2, 0, false)
	out, err := sandboxes.Run(ctx, id, []string{"cat"}, strings.NewReader("stdin reaches it"))
	if err != nil || out.ExitCode != 0 || string(out.Stdout) != "stdin reaches it" || opens() != 3 {
		t.Fatalf("after two restarts = %+v %v, %d opens; want the command's answer on the third", out, err, opens())
	}
	unreachable := func(err error) *SandboxExecError {
		var e *SandboxExecError
		if !errors.As(err, &e) || e.Code != "cave_code_computer_host_unreachable" {
			t.Fatalf("err = %v; want cave_code_computer_host_unreachable", err)
		}
		return e
	}
	// Five opens at most, then the code to the caller.
	before := opens()
	setDown(9, 0, false)
	_, err = sandboxes.Run(ctx, id, []string{"true"}, nil)
	if e := unreachable(err); e.RetryAfter == nil || *e.RetryAfter != 0 || opens()-before != 5 {
		t.Fatalf("a host down every time: %+v after %d opens; want 5", e, opens()-before)
	}
	// A reader read once, and a command whose output came: one open each.
	for _, c := range []struct {
		stdin  io.Reader
		output bool
	}{{io.MultiReader(strings.NewReader("once")), false}, {nil, true}} {
		before = opens()
		setDown(1, 0, c.output)
		_, err = sandboxes.Run(ctx, id, []string{"cat"}, c.stdin)
		if unreachable(err); opens()-before != 1 {
			t.Fatalf("stdin %T, output %v: %d opens; want 1", c.stdin, c.output, opens()-before)
		}
	}
	// A wait past the bound (the far end's retry_after, 30 s): not opened again.
	before = opens()
	setDown(1, 30, false)
	if _, err = sandboxes.Run(ctx, id, []string{"true"}, nil); unreachable(err) != nil && opens()-before != 1 {
		t.Fatalf("a wait past the bound: %d opens; want 1", opens()-before)
	}
	setDown(0, 0, false)
}

// TestSandboxesFilesEachOnAStreamOfTheirOwn: a sandbox's files are written, read, listed,
// described, made, moved and removed, each on a files stream; what the file system refuses is a
// *SandboxFileError (a *SandboxExecError too) with its code and words; a path that is not one never
// opens a stream.
func TestSandboxesFilesEachOnAStreamOfTheirOwn(t *testing.T) {
	f, s, w := newFake(t)
	id := w.Exec["output"].Sandbox
	ctx := context.Background()
	written, err := s.WriteFile(ctx, id, "/notes.txt", strings.NewReader("hello file"), WriteFileOptions{Mode: 0o600, Atomic: true})
	if err != nil || written.Name != "notes.txt" || written.Size != 10 || written.Mode != 0o600 || written.Type != SandboxFileTypeFile {
		t.Fatalf("WriteFile = %+v, %v", written, err)
	}
	if data, err := s.ReadFile(ctx, id, "/notes.txt", FileOptions{}); err != nil || string(data) != "hello file" {
		t.Fatalf("ReadFile = %q, %v", data, err)
	}
	big := bytes.Repeat([]byte("x"), 70000)
	if _, err := s.WriteFile(ctx, id, "/big.bin", bytes.NewReader(big), WriteFileOptions{Root: true}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if info, err := s.StreamFile(ctx, id, "/big.bin", &out, FileOptions{}); err != nil || info.Size != 70000 || !bytes.Equal(out.Bytes(), big) {
		t.Fatalf("StreamFile = %+v %d bytes, %v", info, out.Len(), err)
	}
	if err := s.MakeDir(ctx, id, "/work", true, FileOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameFile(ctx, id, "/notes.txt", "/work/notes.txt", FileOptions{}); err != nil {
		t.Fatal(err)
	}
	names := func() []string {
		entries, err := s.ListFiles(ctx, id, "/", FileOptions{})
		if err != nil {
			t.Fatal(err)
		}
		var n []string
		for _, e := range entries {
			n = append(n, e.Name)
		}
		slices.Sort(n)
		return n
	}
	if got := names(); !slices.Equal(got, []string{"big.bin", "work"}) {
		t.Fatalf("ListFiles = %v", got)
	}
	if info, err := s.StatFile(ctx, id, "/work", FileOptions{}); err != nil || info.Type != SandboxFileTypeDir {
		t.Fatalf("StatFile = %+v, %v", info, err)
	}
	if err := s.RemoveFile(ctx, id, "/work", true, FileOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := names(); !slices.Equal(got, []string{"big.bin"}) {
		t.Fatalf("after RemoveFile, ListFiles = %v", got)
	}
	f.mu.Lock()
	ops := slices.Clone(f.fileOps)
	f.mu.Unlock()
	if want := (filesStart{Type: "files", Op: "write", Path: "/notes.txt", Mode: 0o600, Atomic: true}); ops[0] != want {
		t.Fatalf("first message %+v; want %+v", ops[0], want)
	}
	if !ops[2].Root || !ops[4].Parents || !ops[8].All || ops[5].To != "/work/notes.txt" {
		t.Fatalf("messages %+v", ops)
	}
	for _, c := range []struct {
		call func() error
		code string
	}{
		{func() error { _, err := s.ReadFile(ctx, id, "/gone", FileOptions{}); return err }, "cave_code_computer_file_not_found"},
		{func() error { _, err := s.ReadFile(ctx, id, "/", FileOptions{}); return err }, "cave_code_computer_file_refused"},
		{func() error { return s.MakeDir(ctx, id, "/big.bin", false, FileOptions{}) }, "cave_code_computer_file_exists"},
	} {
		err := c.call()
		var fe *SandboxFileError
		var ee *SandboxExecError
		if !errors.As(err, &fe) || !errors.As(err, &ee) || fe.Code != c.code || !strings.Contains(fe.Message, " /") {
			t.Fatalf("err = %v; want a *SandboxFileError %s with the system's words", err, c.code)
		}
	}
	before := len(ops) + 3
	for _, path := range []string{"relative", "/a\x00b", "/" + strings.Repeat("a", SandboxMaxPath)} {
		var fe *SandboxFileError
		if _, err := s.StatFile(ctx, id, path, FileOptions{}); !errors.As(err, &fe) || fe.Code != "cave_bad_request" {
			t.Fatalf("path %.20q: %v; want cave_bad_request", path, err)
		}
	}
	if err := s.RenameFile(ctx, id, "/big.bin", "nowhere", FileOptions{}); err == nil {
		t.Fatal("a rename to a relative path was not refused")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.fileOps) != before {
		t.Fatalf("%d file operations; want %d: a path that is not one opens no stream", len(f.fileOps), before)
	}
}

// TestSandboxesFileStreamOpenedAgainWhileItsDataCanBeSent: a files stream whose host is restarting
// is opened again while its data can be sent again (a seeker, from where it was); a reader read once
// is not.
func TestSandboxesFileStreamOpenedAgainWhileItsDataCanBeSent(t *testing.T) {
	f, s, w := newFake(t)
	id := w.Exec["output"].Sandbox
	ctx := context.Background()
	opens := func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		n := 0
		for _, seen := range f.seen {
			if strings.HasSuffix(seen, "/files") {
				n++
			}
		}
		return n
	}
	f.mu.Lock()
	f.hostDown = 2
	f.mu.Unlock()
	if _, err := s.WriteFile(ctx, id, "/again.txt", strings.NewReader("sent again"), WriteFileOptions{}); err != nil || opens() != 3 {
		t.Fatalf("after two restarts: %v, %d opens", err, opens())
	}
	if data, err := s.ReadFile(ctx, id, "/again.txt", FileOptions{}); err != nil || string(data) != "sent again" {
		t.Fatalf("ReadFile = %q, %v", data, err)
	}
	f.mu.Lock()
	f.hostDown = 1
	f.mu.Unlock()
	before := opens()
	var fe *SandboxFileError
	if _, err := s.WriteFile(ctx, id, "/once.txt", io.MultiReader(strings.NewReader("once")), WriteFileOptions{}); !errors.As(err, &fe) || fe.Code != "cave_code_computer_host_unreachable" || opens()-before != 1 {
		t.Fatalf("a reader read once: %v after %d opens; want host_unreachable after 1", err, opens()-before)
	}
}

// TestSandboxesDialPort: a port's connection carries bytes both ways and a half close from each
// side; nothing listening is Read's cave_code_computer_port_refused.
func TestSandboxesDialPort(t *testing.T) {
	f, s, w := newFake(t)
	id := w.Exec["output"].Sandbox
	ctx := context.Background()
	conn, err := s.DialPort(ctx, id, 8080)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(conn, "hello port"); err != nil {
		t.Fatal(err)
	}
	if err := conn.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if got, err := io.ReadAll(conn); err != nil || string(got) != "HELLO PORT" {
		t.Fatalf("ReadAll = %q, %v", got, err)
	}
	_ = conn.Close()
	f.mu.Lock()
	f.portRefused = true
	f.mu.Unlock()
	refused, err := s.DialPort(ctx, id, 5432)
	if err != nil {
		t.Fatal(err)
	}
	defer refused.Close()
	var fe *SandboxFileError
	if _, err := io.ReadAll(refused); !errors.As(err, &fe) || fe.Code != "cave_code_computer_port_refused" || fe.Message != "nothing listens on port 5432" {
		t.Fatalf("a refused port: %v", err)
	}
	for _, port := range []int{0, 65536} {
		if _, err := s.DialPort(ctx, id, port); !errors.As(err, &fe) || fe.Code != "cave_bad_request" {
			t.Fatalf("port %d: %v; want cave_bad_request", port, err)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !slices.Equal(f.dialed, []string{"8080", "5432"}) {
		t.Fatalf("dialed %v", f.dialed)
	}
}

func newFake(t *testing.T) (*fakeSandboxes, *Sandboxes, sandboxWire) {
	t.Helper()
	w := loadWire(t)
	f := &fakeSandboxes{t: t, w: w}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	s.pause = func(context.Context, time.Duration) error { return nil }
	return f, s, w
}

func sandboxOf(t *testing.T, raw json.RawMessage) CodeComputer {
	t.Helper()
	var c CodeComputer
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// The plain calls send the key, the route and the body, and read the recorded answers into the
// generated types; a refusal is an *Error with the API's code.
func TestSandboxesCallsSpeakTheRecordedWire(t *testing.T) {
	_, s, w := newFake(t)
	ctx := context.Background()
	id := sandboxOf(t, w.Rest["create"].Answer).Id
	name, never := "wire", 0
	made, err := s.Create(ctx, SandboxesCreateInput{Name: &name, SleepAfterSeconds: &never})
	if err != nil || made.Id != id || !made.Bare || made.SleepAfterSeconds != 0 || made.DesiredState != "running" {
		t.Fatalf("create = %+v %v", made, err)
	}
	// A create answers its idle pause too: none asked, never (0).
	if made.Idle == nil || made.Idle.PauseAfterSeconds == nil || *made.Idle.PauseAfterSeconds != 0 {
		t.Fatalf("create's idle = %+v; want pause_after_seconds 0", made.Idle)
	}
	got, err := s.Get(ctx, id)
	if err != nil || got.ObservedState != SandboxStateRunning {
		t.Fatalf("get = %+v %v", got, err)
	}
	// Get answers the sandbox's idle pause as its create did; a create that asked no lifetime or
	// network answers neither.
	if got.Idle == nil || got.Idle.PauseAfterSeconds == nil || *got.Idle.PauseAfterSeconds != 0 || made.ExpiresAt != nil || made.Network != nil {
		t.Fatalf("get's idle = %+v, create's expires_at %v and network %v; want idle 0 and neither", got.Idle, made.ExpiresAt, made.Network)
	}
	list, err := s.List(ctx, SandboxesListQuery{})
	if err != nil || !list.CloudComputers || len(list.Computers) != 1 || list.Computers[0].Id != id {
		t.Fatalf("list = %+v %v", list, err)
	}
	mine := true
	if list, err := s.List(ctx, SandboxesListQuery{Mine: &mine}); err != nil || len(list.Computers) != 1 {
		t.Fatalf("list mine = %+v %v", list, err)
	}
	if c, err := s.Sleep(ctx, id); err != nil || c.DesiredState != "suspended" {
		t.Fatalf("sleep = %+v %v", c, err)
	}
	if c, err := s.Resume(ctx, id); err != nil || c.DesiredState != "running" {
		t.Fatalf("resume = %+v %v", c, err)
	}
	if c, err := s.Delete(ctx, id); err != nil || c.DesiredState != "deleted" {
		t.Fatalf("delete = %+v %v", c, err)
	}
	// A delete asked again answers the deleted sandbox, as the first did.
	if c, err := s.Delete(ctx, id); err != nil || c.DesiredState != "deleted" || c.Id != id {
		t.Fatalf("delete again = %+v %v; want the deleted sandbox", c, err)
	}
	for _, c := range []struct {
		name string
		call func() error
		code string
		want int
	}{
		{"get_unknown", func() error {
			_, err := s.Get(ctx, strings.TrimPrefix(w.Rest["get_unknown"].Path, "/api/v1/code/computers/"))
			return err
		}, SandboxErrorNotFound, 404},
		{"create_bad_size", func() error { size := "huge"; _, err := s.Create(ctx, SandboxesCreateInput{Size: &size}); return err }, SandboxErrorBadRequest, 400},
	} {
		var e *Error
		if err := c.call(); !errors.As(err, &e) || e.Code != c.code || e.Status != c.want || e.Message == "" || e.RequestID == "" {
			t.Errorf("%s = %#v; want %s %d with its message and request id", c.name, err, c.code, c.want)
		}
	}
}

// With the switch off, a key's list is cave_api_key_route_forbidden, and its create a 405 that says
// sandboxes are not offered.
func TestSandboxesSayWhenTheAPIIsOff(t *testing.T) {
	w := loadWire(t)
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		c := w.Rest["off_list"]
		if r.Method == http.MethodPost {
			c = w.Rest["off_create"]
		}
		rw.WriteHeader(c.Status)
		_, _ = rw.Write(c.Answer)
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	var e *Error
	if _, err := s.List(context.Background(), SandboxesListQuery{}); !errors.As(err, &e) || e.Code != SandboxErrorApiKeyRouteForbidden || e.Status != 403 {
		t.Fatalf("list off = %#v", err)
	}
	if _, err := s.Create(context.Background(), SandboxesCreateInput{}); !errors.As(err, &e) || e.Status != 405 || !strings.Contains(e.Message, "computers.api.enabled") {
		t.Fatalf("create off = %#v", err)
	}
}

// A command's output comes back on its channel and its exit code is answered; stdin reaches it;
// output larger than one message arrives whole.
func TestSandboxesExecReplaysTheRecordedStreams(t *testing.T) {
	_, s, w := newFake(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id := w.Exec["output"].Sandbox
	res, err := s.Run(ctx, id, []string{"sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 7"}, nil)
	if err != nil || res.ExitCode != 7 || string(res.Stdout) != "hello from the sandbox\n" || string(res.Stderr) != "careful\n" {
		t.Fatalf("output = %d %q %q %v", res.ExitCode, res.Stdout, res.Stderr, err)
	}
	res, err = s.Run(ctx, id, []string{"cat"}, strings.NewReader("stdin reaches it"))
	if err != nil || res.ExitCode != 0 || string(res.Stdout) != "stdin reaches it" {
		t.Fatalf("stdin = %d %q %v", res.ExitCode, res.Stdout, err)
	}
	// A stdin that fails after its first piece: the command's input ends there.
	res, err = s.Run(ctx, id, []string{"cat"}, io.MultiReader(strings.NewReader("stdin reaches it"), failingReader{}))
	if err != nil || res.ExitCode != 0 || string(res.Stdout) != "stdin reaches it" {
		t.Fatalf("a failing stdin = %d %q %v", res.ExitCode, res.Stdout, err)
	}
	res, err = s.Run(ctx, id, []string{"sh", "-c", "head -c 40000 /dev/zero | tr '\\0' a"}, nil)
	if err != nil || res.ExitCode != 0 || len(res.Stdout) != 40000 || strings.Trim(string(res.Stdout), "a") != "" {
		t.Fatalf("large = %d %d %v", res.ExitCode, len(res.Stdout), err)
	}
}

// What ends a stream without an exit is a *SandboxExecError with the sandbox's code: an error
// message and its close, a refusal before the upgrade (the service's JSON, or the relay's plain
// text), and a close with no message (named by its code).
func TestSandboxesExecErrorsCarryTheStreamsCodes(t *testing.T) {
	f, s, w := newFake(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id := w.Exec["output"].Sandbox
	run := func() *SandboxExecError {
		t.Helper()
		res, err := s.Run(ctx, id, []string{"true"}, nil)
		var e *SandboxExecError
		if !errors.As(err, &e) {
			t.Fatalf("run = %#v %+v; want a *SandboxExecError", err, res)
		}
		return e
	}
	// A sandbox that takes no options closes a start that asks for one with unsupported.
	unsupported := 4405
	f.set("stdin", "", &unsupported)
	if e := run(); e.Code != "cave_code_computer_unsupported" || e.CloseCode != 4405 {
		t.Errorf("a start a sandbox without options refuses = %+v", e)
	}
	for name, want := range map[string]struct {
		code   string
		status int
	}{"asleep": {"cave_code_computer_not_running", 409}, "unknown": {"cave_not_found", 404}, "switched_off": {"cave_not_found", 404}} {
		f.set("", name, nil)
		if e := run(); e.Code != want.code || e.Status != want.status || e.Message == "" {
			t.Errorf("%s = %+v; want %+v", name, e, want)
		}
	}
	for code, want := range map[int]string{4401: "cave_unauthorized", 4404: "cave_code_computer_stream_ended", 4410: "cave_code_computer_stopped", 1001: "cave_code_computer_stream_ended"} {
		f.set("stdin", "", &code)
		e := run()
		if e.Code != want || e.CloseCode != code {
			t.Errorf("close %d = %+v; want %s", code, e, want)
		}
	}
	if _, err := s.Run(ctx, id, nil, nil); err == nil {
		t.Error("an empty argv ran")
	}
}

// TestSandboxesExecOptionsAndControls: a command's options reach it (the recordings' answers), a
// signal asked before the stream opens goes once it does and ends the command (128 + SIGINT), and a
// resize the sandbox did not act on comes to OnRefused, the command going on; what the sandbox would
// refuse is refused here, before a stream opens.
func TestSandboxesExecOptionsAndControls(t *testing.T) {
	f, s, w := newFake(t)
	ctx := context.Background()
	id := w.Exec["output"].Sandbox
	said := func(name string) string {
		var out strings.Builder
		for _, m := range w.Exec[name].Server {
			if m.Channel == 1 {
				out.WriteString(m.Data)
			}
		}
		return out.String()
	}
	var out bytes.Buffer
	if code, err := s.Exec(ctx, id, []string{"pwd"}, ExecOptions{Cwd: "/tmp", Stdout: &out}); err != nil || code != 0 || out.String() != said("start_with_cwd") {
		t.Fatalf("pwd in /tmp = %d %q %v", code, out.String(), err)
	}
	out.Reset()
	if code, err := s.Exec(ctx, id, []string{"sh", "-c", `echo "$GREETING"`}, ExecOptions{Env: map[string]string{"GREETING": "hello env"}, Stdout: &out}); err != nil || code != 0 || out.String() != "hello env\n" {
		t.Fatalf("with env = %d %q %v", code, out.String(), err)
	}
	command := &SandboxCommand{}
	if err := command.SendSignal("SIGINT"); err != nil {
		t.Fatal(err)
	}
	if code, err := s.Exec(ctx, id, []string{"sleep", "5"}, ExecOptions{Control: command}); err != nil || code != 130 {
		t.Fatalf("a signalled command = %d %v; want 130", code, err)
	}
	var refusals []SandboxRefusal
	resized := &SandboxCommand{}
	if err := resized.Resize(80, 24); err != nil {
		t.Fatal(err)
	}
	if code, err := s.Exec(ctx, id, []string{"sh", "-c", "sleep 1"}, ExecOptions{Control: resized, OnRefused: func(r SandboxRefusal) { refusals = append(refusals, r) }}); err != nil || code != 0 {
		t.Fatalf("a resized command with no terminal = %d %v", code, err)
	}
	if want := []SandboxRefusal{{Of: "resize", Code: "cave_code_computer_unsupported", Message: "the command has no terminal to resize"}}; !reflect.DeepEqual(refusals, want) {
		t.Fatalf("refusals %+v; want %+v", refusals, want)
	}
	f.mu.Lock()
	opened := len(f.seen)
	f.mu.Unlock()
	bad := func(what string, err error) {
		t.Helper()
		var e *SandboxExecError
		if !errors.As(err, &e) || e.Code != "cave_bad_request" {
			t.Errorf("%s = %v; want cave_bad_request", what, err)
		}
	}
	bad("signal BOGUS", command.SendSignal("BOGUS"))
	bad("resize 0x24", command.Resize(0, 24))
	bad("resize past the bound", command.Resize(80, SandboxMaxTermSize+1))
	many := map[string]string{}
	for i := range SandboxMaxEnv + 1 {
		many[fmt.Sprintf("V%d", i)] = "x"
	}
	for _, o := range []ExecOptions{{Cols: 80, Rows: 24}, {TTY: true, Cols: 80}, {Cwd: "relative"}, {Env: map[string]string{"A=B": "x"}},
		{Env: map[string]string{"": "x"}}, {Env: map[string]string{"A": "a\x00b"}}, {Env: many}} {
		_, err := s.Exec(ctx, id, []string{"true"}, o)
		bad(fmt.Sprintf("options %+v", o)[:40], err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.seen) != opened {
		t.Fatalf("%d streams opened for options refused here", len(f.seen)-opened)
	}
}

// Ending the context ends the stream (the sandbox ends the command); a command that keeps running
// is not waited for.
func TestSandboxesExecEndsWithItsContext(t *testing.T) {
	hold := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: %s\r\n\r\n", wsAccept(r.Header.Get("Sec-WebSocket-Key")), SandboxStreamSubprotocol)
		_ = rw.Flush()
		for {
			if _, _, _, err := readFrame(rw.Reader, 1<<20, true); err != nil {
				close(hold)
				return
			}
		}
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := s.Exec(ctx, "01a1f5db-671c-7622-93b8-9ed320c07da7", []string{"sleep", "60"}, ExecOptions{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("exec past its context = %v", err)
	}
	select {
	case <-hold:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream stayed open after its context ended")
	}
}

// A GET is asked again after a 503, any call after a 429, a delete after cave_code_computer_busy;
// a create after a 503 is not: it may have been made.
func TestSandboxesRetryOnlyWhatTheAPISaysMayBeAskedAgain(t *testing.T) {
	w := loadWire(t)
	got, deleted := w.Rest["get"].Answer, w.Rest["delete"].Answer
	envelope := func(code string) string {
		return `{"error":{"type":"cave_gateway_error","code":"` + code + `","message":"Ask again.","request_id":"r"}}`
	}
	var mu sync.Mutex
	counts := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		counts[r.Method]++
		n := counts[r.Method]
		mu.Unlock()
		switch {
		case r.Method == "GET" && n <= 2:
			rw.WriteHeader(503)
			fmt.Fprint(rw, envelope("cave_unavailable"))
		case r.Method == "GET":
			_, _ = rw.Write(got)
		case r.Method == "POST" && r.URL.Path == "/api/v1/code/computers" && r.Header.Get("X-Case") == "busy":
			rw.Header().Set("Retry-After", "0")
			rw.WriteHeader(429)
			fmt.Fprint(rw, envelope("cave_rate_limited"))
			mu.Lock()
			counts["429"]++
			mu.Unlock()
		case r.Method == "POST":
			rw.WriteHeader(503)
			fmt.Fprint(rw, envelope("cave_unavailable"))
		case r.Method == "DELETE" && n == 1:
			rw.WriteHeader(409)
			fmt.Fprint(rw, envelope(SandboxErrorCodeComputerBusy))
		case r.Method == "DELETE":
			_, _ = rw.Write(deleted)
		}
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	s.pause = func(context.Context, time.Duration) error { return nil }
	ctx := context.Background()
	if _, err := s.Get(ctx, "x"); err != nil || counts["GET"] != 3 {
		t.Fatalf("get after two 503s = %v after %d asks", err, counts["GET"])
	}
	var e *Error
	if _, err := s.Create(ctx, SandboxesCreateInput{}); !errors.As(err, &e) || e.Status != 503 || counts["POST"] != 1 {
		t.Fatalf("create after a 503 = %v after %d asks; want it asked once", err, counts["POST"])
	}
	if _, err := s.Delete(ctx, "x"); err != nil || counts["DELETE"] != 2 {
		t.Fatalf("delete after busy = %v after %d asks", err, counts["DELETE"])
	}
	s.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		r.Header.Set("X-Case", "busy")
		return http.DefaultTransport.RoundTrip(r)
	})
	if _, err := s.Create(ctx, SandboxesCreateInput{}); !errors.As(err, &e) || e.Status != 429 || counts["429"] != 4 {
		t.Fatalf("create on 429 = %v after %d asks; want 4 (once and 3 more)", err, counts["429"])
	}
}

// A Retry-After past the client's longest wait (an organization's start ceiling names up to a day)
// is answered at once, its seconds on the error, with one request sent; one within it is waited
// for and asked again, as before.
func TestSandboxesAnswerAWaitPastTheirLongestAtOnce(t *testing.T) {
	w := loadWire(t)
	var mu sync.Mutex
	asks, after := 0, "3600"
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asks++
		n, wait := asks, after
		mu.Unlock()
		if wait == "2" && n > 1 {
			rw.WriteHeader(201)
			_, _ = rw.Write(w.Rest["create"].Answer)
			return
		}
		rw.Header().Set("Retry-After", wait)
		rw.WriteHeader(429)
		fmt.Fprint(rw, `{"error":{"type":"cave_gateway_error","code":"cave_code_computer_start_ceiling","message":"Try again in about 60 minutes.","request_id":"r"}}`)
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	count := func() int { mu.Lock(); defer mu.Unlock(); return asks }
	began := time.Now()
	var e *Error
	if _, err := s.Create(context.Background(), SandboxesCreateInput{}); !errors.As(err, &e) || e.Status != 429 || e.Code != "cave_code_computer_start_ceiling" || e.RetryAfter == nil || *e.RetryAfter != 3600 {
		t.Fatalf("a create told to wait an hour = %v (%+v); want the 429 with its 3600 seconds", err, e)
	}
	if took := time.Since(began); took > time.Second || count() != 1 {
		t.Fatalf("it answered after %s and %d requests; want at once, one request", took, count())
	}
	mu.Lock()
	asks, after = 0, "2"
	mu.Unlock()
	var paused []time.Duration
	s.pause = func(_ context.Context, d time.Duration) error { paused = append(paused, d); return nil }
	if _, err := s.Create(context.Background(), SandboxesCreateInput{}); err != nil || count() != 2 || len(paused) != 1 || paused[0] != 2*time.Second {
		t.Fatalf("a create told to wait 2 s = %v after %d requests, paused %v; want it asked again after 2 s", err, count(), paused)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("the pipe broke") }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Waiting reads until the state, and stops on a failure or on a sandbox asked to be something else.
func TestSandboxesWaitForAState(t *testing.T) {
	w := loadWire(t)
	base := sandboxOf(t, w.Rest["get"].Answer)
	var mu sync.Mutex
	states := []string{"pending", "starting", "running"}
	desired := "running"
	reason, code := "", ""
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		c := base
		c.ObservedState, c.DesiredState = states[0], desired
		if reason != "" {
			c.ObservedReason = &reason
		}
		if code != "" {
			c.ObservedReasonCode = &code
		}
		if len(states) > 1 {
			states = states[1:]
		}
		_ = json.NewEncoder(rw).Encode(c)
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	s.pause = func(context.Context, time.Duration) error { return nil }
	ctx := context.Background()
	if c, err := s.Wait(ctx, base.Id, SandboxStateRunning); err != nil || c.ObservedState != "running" {
		t.Fatalf("wait running = %+v %v", c, err)
	}
	mu.Lock()
	states, reason = []string{"starting", "failed"}, "image missing"
	mu.Unlock()
	var se *SandboxStateError
	if _, err := s.Wait(ctx, base.Id, SandboxStateRunning); !errors.As(err, &se) || se.Observed != "failed" || se.Reason != "image missing" {
		t.Fatalf("wait on a failure = %v", err)
	}
	mu.Lock()
	states, desired, reason = []string{"starting"}, "suspended", ""
	mu.Unlock()
	if _, err := s.Wait(ctx, base.Id, SandboxStateRunning); !errors.As(err, &se) || se.Desired != "suspended" {
		t.Fatalf("wait running on a sandbox asked to sleep = %v", err)
	}
	// A reason that passes by itself: the wait goes on, even while the sandbox reads failed (its host restarting).
	mu.Lock()
	states, desired, code, reason = []string{"failed", "failed", "running"}, "running", SandboxReasonHostUnavailable, "Its host is restarting or not answering just now; Cloud tries again in a moment."
	mu.Unlock()
	if c, err := s.Wait(ctx, base.Id, SandboxStateRunning); err != nil || c.ObservedState != "running" {
		t.Fatalf("wait through host_unavailable = %+v %v", c, err)
	}
	// One that needs the caller ends it, whatever the state.
	mu.Lock()
	states, code, reason = []string{"stopped"}, SandboxReasonStoppedByHost, "Its host restarted or ran short of memory, so it was stopped; its disk is kept. Start it again."
	mu.Unlock()
	if _, err := s.Wait(ctx, base.Id, SandboxStateRunning); !errors.As(err, &se) || se.ReasonCode != SandboxReasonStoppedByHost || !strings.Contains(err.Error(), "is stopped: Its host restarted") {
		t.Fatalf("wait on stopped_by_host = %v", err)
	}
	// Cloud's own ends it once the sandbox has failed, and a code this client does not know reads as none.
	for _, unknown := range []string{SandboxReasonInternalError, "a_later_code"} {
		mu.Lock()
		states, code, reason = []string{"starting", "starting", "failed"}, unknown, "went wrong"
		mu.Unlock()
		if _, err := s.Wait(ctx, base.Id, SandboxStateRunning); !errors.As(err, &se) || se.Observed != "failed" || se.Reason != "went wrong" {
			t.Fatalf("wait on %s = %v", unknown, err)
		}
		mu.Lock()
		left := len(states)
		mu.Unlock()
		if left != 1 {
			t.Fatalf("wait on %s ended before the sandbox failed", unknown)
		}
	}
}

// The API holds the read until the state: one request with wait_for and timeout, and its Cave-Wait
// decides; a Caveman Cloud that answers no Cave-Wait is polled from then on; at the API's cap on one
// caller's waits, the read is a plain one.
func TestSandboxesWaitIsHeldByTheAPI(t *testing.T) {
	w := loadWire(t)
	base := sandboxOf(t, w.Rest["get"].Answer)
	type answer struct {
		observed, wait string
		after          time.Duration
		status         int
	}
	var mu sync.Mutex
	var asked []string
	var answers []answer
	code := "" // every answer's observed_reason_code while set
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.URL.RawQuery)
		reason := code
		a := answers[0]
		if len(answers) > 1 {
			answers = answers[1:]
		}
		mu.Unlock()
		time.Sleep(a.after)
		rw.Header().Set("Content-Type", "application/json")
		if a.status == http.StatusTooManyRequests && r.URL.Query().Has("wait_for") {
			rw.Header().Set("Retry-After", "0")
			rw.WriteHeader(a.status)
			_, _ = io.WriteString(rw, `{"error":{"type":"cave_gateway_error","code":"cave_code_computer_waits_limit","message":"As many waits as it may.","request_id":"r"}}`)
			return
		}
		if a.wait != "" {
			rw.Header().Set("Cave-Wait", a.wait)
		}
		c := base
		c.ObservedState = a.observed
		if reason != "" {
			c.ObservedReasonCode = &reason
		}
		_ = json.NewEncoder(rw).Encode(c)
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	var paused []time.Duration
	s.pause = func(_ context.Context, d time.Duration) error { paused = append(paused, d); return nil }
	run := func(ctx context.Context, set []answer) ([]string, CodeComputer, error) {
		t.Helper()
		mu.Lock()
		asked, answers, paused = nil, set, nil
		mu.Unlock()
		c, err := s.Wait(ctx, base.Id, SandboxStateRunning)
		mu.Lock()
		defer mu.Unlock()
		return asked, c, err
	}
	// Held until it runs: one request, as long as the wait (at most the API's minute).
	if got, c, err := run(context.Background(), []answer{{"running", "satisfied", 300 * time.Millisecond, 0}}); err != nil || c.ObservedState != "running" ||
		strings.Join(got, " ") != "timeout=60&wait_for=running" {
		t.Fatalf("held = %v %+v %v", got, c, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3500*time.Millisecond)
	if got, _, err := run(ctx, []answer{{"running", "satisfied", 0, 0}}); err != nil || strings.Join(got, " ") != "timeout=3&wait_for=running" {
		t.Fatalf("held within 3.5 s = %v %v", got, err)
	}
	cancel()
	// A held read that timed out is asked again at once; one the API says cannot end there ends the wait.
	if got, c, err := run(context.Background(), []answer{{"starting", "timeout", 1100 * time.Millisecond, 0}, {"running", "satisfied", 0, 0}}); err != nil || c.ObservedState != "running" || len(got) != 2 || len(paused) != 0 {
		t.Fatalf("timeout then satisfied = %v %+v %v, paused %v", got, c, err, paused)
	}
	var se *SandboxStateError
	if _, _, err := run(context.Background(), []answer{{"starting", "unreachable", 0, 0}}); !errors.As(err, &se) {
		t.Fatalf("unreachable = %v", err)
	}
	// The API's verdict decides, by the same reason codes: a failed sandbox whose host is restarting,
	// which it held and answered timeout, is waited on.
	mu.Lock()
	code = SandboxReasonHostUnavailable
	mu.Unlock()
	if got, c, err := run(context.Background(), []answer{{"failed", "timeout", 1100 * time.Millisecond, 0}, {"running", "satisfied", 0, 0}}); err != nil || c.ObservedState != "running" || len(got) != 2 {
		t.Fatalf("failed with host_unavailable, held = %v %+v %v", got, c, err)
	}
	mu.Lock()
	code = SandboxReasonOutOfMemory
	mu.Unlock()
	if _, _, err := run(context.Background(), []answer{{"failed", "unreachable", 0, 0}}); !errors.As(err, &se) || se.ReasonCode != SandboxReasonOutOfMemory {
		t.Fatalf("failed with out_of_memory, unreachable = %v", err)
	}
	mu.Lock()
	code = ""
	mu.Unlock()
	// No Cave-Wait: polled from then on, never asked to wait again.
	if got, c, err := run(context.Background(), []answer{{"pending", "", 0, 0}, {"starting", "", 0, 0}, {"running", "", 0, 0}}); err != nil || c.ObservedState != "running" ||
		strings.Join(got, "|") != "timeout=60&wait_for=running||" {
		t.Fatalf("a Cloud that does not wait = %q %+v %v", got, c, err)
	}
	// At the cap: the read asked again as 429s are (Retry-After), then a plain one.
	if got, c, err := run(context.Background(), []answer{{"running", "", 0, http.StatusTooManyRequests}}); err != nil || c.ObservedState != "running" ||
		strings.Join(got, "|") != strings.Repeat("timeout=60&wait_for=running|", 4) {
		t.Fatalf("at the cap = %q %+v %v", got, c, err)
	}
}

func TestNewSandboxesRefusesWhatItCannotUse(t *testing.T) {
	for _, o := range []SandboxesOptions{
		{ControlURL: "http://cloud.example", APIKey: "k"},
		{ControlURL: "https://cloud.example/api", APIKey: "k"},
		{ControlURL: "https://user:pw@cloud.example", APIKey: "k"},
		{ControlURL: "https://cloud.example", APIKey: " "},
		{ControlURL: "https://cloud.example", RelayURL: "http://relay.example", APIKey: "k"},
	} {
		if _, err := NewSandboxes(o); err == nil {
			t.Errorf("NewSandboxes(%+v) accepted", o)
		}
	}
	s, err := NewSandboxes(SandboxesOptions{ControlURL: "https://cloud.example/", RelayURL: "https://app.example", APIKey: "k"})
	if err != nil || s.endpoint != "https://cloud.example/api/v1" || s.relay != "https://app.example" {
		t.Fatalf("NewSandboxes = %+v %v", s, err)
	}
}

// sandboxesStatusAnswer is an answer of GET /api/v1/status/sandboxes as control-api computes it.
const sandboxesStatusAnswer = `{"state":"degraded","checked_at":"2026-11-19T12:00:05Z","last_round_at":"2026-11-19T12:00:00Z","interval_seconds":60,"stale_after_seconds":300,"window_seconds":3600,` +
	`"probes":[{"name":"create","state":"ok","last_success_at":"2026-11-19T12:00:00Z","attempts":60,"failures":0,"p50_ms":210,"p95_ms":480},` +
	`{"name":"running","state":"ok","last_success_at":"2026-11-19T12:00:00Z","attempts":60,"failures":0,"p50_ms":800,"p95_ms":1200},` +
	`{"name":"exec_open","state":"degraded","last_success_at":"2026-11-19T12:00:00Z","attempts":60,"failures":2,"p50_ms":50,"p95_ms":90},` +
	`{"name":"command","state":"ok","last_success_at":"2026-11-19T12:00:00Z","attempts":58,"failures":0,"p50_ms":100,"p95_ms":140},` +
	`{"name":"delete","state":"unknown","last_success_at":null,"attempts":0,"failures":0,"p50_ms":null,"p95_ms":null}],` +
	`"create_to_command":{"state":"ok","threshold_ms":2000,"p95_ms":1400}}`

// Status reads whether sandboxes work right now (GET /api/v1/status/sandboxes); the route is public,
// and the key the client sends is ignored there. An installation that does not serve it answers 404.
func TestSandboxesStatusReadsThePublicStatus(t *testing.T) {
	var asked []string
	served := true
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Method+" "+r.URL.Path)
		rw.Header().Set("content-type", "application/json")
		if !served {
			rw.WriteHeader(http.StatusNotFound)
			_, _ = rw.Write([]byte(`{"error":{"type":"cave_gateway_error","code":"cave_not_found","message":"Not found.","request_id":"req_1"}}`))
			return
		}
		_, _ = rw.Write([]byte(sandboxesStatusAnswer))
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.Status(context.Background())
	if err != nil || st.State != "degraded" || len(st.Probes) != 5 || st.Probes[2].Name != "exec_open" || st.Probes[2].Failures != 2 ||
		st.Probes[4].LastSuccessAt != nil || st.Probes[4].P95Ms != nil || *st.StaleAfterSeconds != 300 || st.CreateToCommand.ThresholdMs != 2000 {
		t.Fatalf("status = %+v %v", st, err)
	}
	if strings.Join(asked, ",") != "GET /api/v1/status/sandboxes" {
		t.Fatalf("asked %v", asked)
	}
	served = false
	var e *Error
	if _, err := s.Status(context.Background()); !errors.As(err, &e) || e.Code != SandboxErrorNotFound || e.Status != 404 {
		t.Fatalf("not served = %#v", err)
	}
}

// URL answers a port at its own URL: the token route with the key, the header a program sends,
// the link and its times; Public sets the visibility first; a port or a TTL out of range is refused
// before anything is sent; an install that does not serve ports so answers a typed refusal.
func TestSandboxesURL(t *testing.T) {
	const id = "01a1f7fb-1a13-7f03-98d8-97e28b8755a5"
	portURL := "https://3000-" + id + ".sandbox.example.dev"
	type call struct{ method, path, auth, body string }
	var mu sync.Mutex
	var seen []call
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, call{r.Method, r.URL.Path, r.Header.Get("Authorization"), string(body)})
		public := slices.ContainsFunc(seen, func(c call) bool { return c.method == http.MethodPut })
		mu.Unlock()
		rw.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/v1/code/computers/"+id+"/ports/3000":
			var in struct{ Visibility string }
			_ = json.Unmarshal(body, &in)
			_ = json.NewEncoder(rw).Encode(map[string]any{"port": 3000, "visibility": in.Visibility, "url": portURL})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/code/computers/"+id+"/ports/3000/token":
			visibility, expires := "private", "2026-11-20T13:00:00Z"
			if public {
				visibility = "public"
			}
			if strings.Contains(string(body), `"ttl_seconds":600`) {
				expires = "2026-11-20T12:10:00Z"
			}
			_ = json.NewEncoder(rw).Encode(map[string]any{"computer_id": id, "port": 3000, "visibility": visibility, "url": portURL,
				"link": portURL + "/_caveman/open?token=cvp_link", "link_expires_at": "2026-11-20T12:05:00Z", "token": "cvp_access",
				"header": "Caveman-Port-Token", "expires_at": expires})
		default:
			rw.WriteHeader(http.StatusNotFound)
			_, _ = rw.Write([]byte(`{"error":{"type":"cave_gateway_error","code":"cave_not_found","message":"Not found.","request_id":"req_port"}}`))
		}
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	got, err := s.URL(ctx, id, 3000, URLOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != portURL || got.Link != portURL+"/_caveman/open?token=cvp_link" || got.Token != "cvp_access" || got.Headers.Get("Caveman-Port-Token") != "cvp_access" ||
		got.Visibility != "private" || !got.LinkExpiresAt.Equal(time.Date(2026, 11, 20, 12, 5, 0, 0, time.UTC)) || !got.ExpiresAt.Equal(time.Date(2026, 11, 20, 13, 0, 0, 0, time.UTC)) {
		t.Fatalf("URL = %+v", got)
	}
	if want := []call{{http.MethodPost, "/api/v1/code/computers/" + id + "/ports/3000/token", "Bearer cave_live_wire", "{}"}}; !reflect.DeepEqual(seen, want) {
		t.Fatalf("sent %+v; want %+v", seen, want)
	}
	// Public makes the port public before the token is asked; TTL is sent as ttl_seconds.
	seen = nil
	public := true
	got, err = s.URL(ctx, id, 3000, URLOptions{Public: &public, TTL: 10 * time.Minute})
	if err != nil || got.Visibility != "public" || !got.ExpiresAt.Equal(time.Date(2026, 11, 20, 12, 10, 0, 0, time.UTC)) {
		t.Fatalf("URL public = %+v, %v", got, err)
	}
	if len(seen) != 2 || seen[0].method != http.MethodPut || seen[0].body != `{"visibility":"public"}` || seen[1].method != http.MethodPost || seen[1].body != `{"ttl_seconds":600}` {
		t.Fatalf("sent %+v; want the PUT, then the token with ttl_seconds 600", seen)
	}
	// A port or a TTL out of range is refused here, before anything is sent.
	seen = nil
	var e *Error
	for _, bad := range []int{0, 65536} {
		if _, err := s.URL(ctx, id, bad, URLOptions{}); !errors.As(err, &e) || e.Code != "cave_bad_request" || e.Status != 0 {
			t.Fatalf("URL port %d = %v", bad, err)
		}
	}
	for _, ttl := range []time.Duration{30 * time.Second, 25 * time.Hour, 90*time.Second + time.Millisecond} {
		if _, err := s.URL(ctx, id, 3000, URLOptions{TTL: ttl}); !errors.As(err, &e) || e.Code != "cave_bad_request" {
			t.Fatalf("URL ttl %v = %v", ttl, err)
		}
	}
	if len(seen) != 0 {
		t.Fatalf("a refused URL sent %+v", seen)
	}
	// An install that does not serve ports at their own URLs answers the route as an unknown one.
	if _, err := s.URL(ctx, id, 8080, URLOptions{}); !errors.As(err, &e) || e.Code != SandboxErrorNotFound || e.Status != 404 || e.RequestID != "req_port" {
		t.Fatalf("URL off = %#v", err)
	}
	if p, err := s.SetPort(ctx, id, 3000, SandboxesSetPortInput{Visibility: "private"}); err != nil || p.Visibility != "private" {
		t.Fatalf("SetPort = %+v, %v", p, err)
	}
}
