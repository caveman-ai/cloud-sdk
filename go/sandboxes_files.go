package cavemancloud

// A sandbox's files and ports, each on a stream of its own through the relay (SandboxFilesPath,
// SandboxDialPath), on the same WebSocket as a command's (sandboxes.go).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// SandboxFileError is a file operation's or a port's stream that ended without its answer: what
// the sandbox's file system refused (cave_code_computer_file_not_found, _file_permission,
// _file_exists, _file_too_large, _file_refused, with the system's own words), nothing listening on
// the port (cave_code_computer_port_refused), or any of a stream's codes. errors.As finds the
// *SandboxExecError in it too.
type SandboxFileError struct {
	SandboxExecError
}

func (e *SandboxFileError) Error() string { return "sandbox file: " + e.Code + ": " + e.Message }

// Unwrap answers the stream's error, so errors.As(err, &*SandboxExecError) holds for it.
func (e *SandboxFileError) Unwrap() error { return &e.SandboxExecError }

func fileError(code, message string) *SandboxFileError {
	return &SandboxFileError{SandboxExecError{Code: code, Message: message}}
}

// SandboxFileInfo is a file in a sandbox, as a file operation describes it: Mode is its permission
// bits, ModTime UTC (RFC 3339), Link where a symbolic link points.
type SandboxFileInfo struct {
	Name    string `json:"name"`
	Type    string `json:"type"` // SandboxFileTypeFile, SandboxFileTypeDir, SandboxFileTypeSymlink or SandboxFileTypeOther
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	ModTime string `json:"mtime"`
	Link    string `json:"link,omitempty"`
}

// FileOptions are what a file operation gets besides its path: Root acts as the sandbox's root, not
// its tool-process user (a full sandbox's).
type FileOptions struct {
	Root bool
}

// WriteFileOptions are a write's: Mode is a new file's permission bits (0o644 when 0); Atomic writes
// beside the path and renames over it, so a reader finds the old file or the new one.
type WriteFileOptions struct {
	Root   bool
	Mode   uint32
	Atomic bool
}

// filesStart is a files stream's first message.
type filesStart struct {
	Type    string `json:"type"`
	Op      string `json:"op"`
	Path    string `json:"path"`
	To      string `json:"to,omitempty"`
	Root    bool   `json:"root,omitempty"`
	Mode    uint32 `json:"mode,omitempty"`
	Atomic  bool   `json:"atomic,omitempty"`
	Parents bool   `json:"parents,omitempty"`
	All     bool   `json:"all,omitempty"`
}

// ReadFile reads a file of a sandbox whole.
func (s *Sandboxes) ReadFile(ctx context.Context, sandboxID, path string, options FileOptions) ([]byte, error) {
	var out bytes.Buffer
	_, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpRead, Path: path, Root: options.Root}, nil, &out)
	return out.Bytes(), err
}

// StreamFile reads a file of a sandbox to w as it comes, and describes it. A stream opened again
// (see WriteFile) is only one before any of the file came, so w sees each byte once.
func (s *Sandboxes) StreamFile(ctx context.Context, sandboxID, path string, w io.Writer, options FileOptions) (SandboxFileInfo, error) {
	file, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpRead, Path: path, Root: options.Root}, nil, w)
	return file, err
}

// WriteFile makes or replaces a file of a sandbox with what data reads (its folder must be there),
// and describes it once written. A stream the sandbox says to open again (its host restarting) is
// opened again, as Exec's is, while data can be sent again: an io.Seeker, from where it was.
func (s *Sandboxes) WriteFile(ctx context.Context, sandboxID, path string, data io.Reader, options WriteFileOptions) (SandboxFileInfo, error) {
	if data == nil {
		data = bytes.NewReader(nil)
	}
	file, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpWrite, Path: path, Root: options.Root, Mode: options.Mode, Atomic: options.Atomic}, data, nil)
	return file, err
}

// ListFiles lists a folder of a sandbox, in no order.
func (s *Sandboxes) ListFiles(ctx context.Context, sandboxID, path string, options FileOptions) ([]SandboxFileInfo, error) {
	_, entries, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpList, Path: path, Root: options.Root}, nil, nil)
	return entries, err
}

// StatFile describes a file of a sandbox, a symbolic link as itself.
func (s *Sandboxes) StatFile(ctx context.Context, sandboxID, path string, options FileOptions) (SandboxFileInfo, error) {
	file, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpStat, Path: path, Root: options.Root}, nil, nil)
	return file, err
}

// MakeDir makes a folder of a sandbox; with parents, the folders above it that are not there (one
// there is then no error).
func (s *Sandboxes) MakeDir(ctx context.Context, sandboxID, path string, parents bool, options FileOptions) error {
	_, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpMkdir, Path: path, Parents: parents, Root: options.Root}, nil, nil)
	return err
}

// RemoveFile removes a file or an empty folder of a sandbox; with all, a folder and all it holds.
func (s *Sandboxes) RemoveFile(ctx context.Context, sandboxID, path string, all bool, options FileOptions) error {
	_, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpRemove, Path: path, All: all, Root: options.Root}, nil, nil)
	return err
}

// RenameFile renames a file or folder of a sandbox, replacing a file at to as rename(2) does.
func (s *Sandboxes) RenameFile(ctx context.Context, sandboxID, path, to string, options FileOptions) error {
	_, _, err := s.files(ctx, sandboxID, filesStart{Op: SandboxFileOpRename, Path: path, To: to, Root: options.Root}, nil, nil)
	return err
}

// files is one file operation (SandboxFilesPath): the first message, data then close_stdin (a
// write's), and the answer: bytes to sink, a file, entries, or done. It opens the stream again as
// Exec does, while nothing of the answer came and data can be sent again.
func (s *Sandboxes) files(ctx context.Context, sandboxID string, start filesStart, data io.Reader, sink io.Writer) (SandboxFileInfo, []SandboxFileInfo, error) {
	if err := checkPath(start.Path); err != nil {
		return SandboxFileInfo{}, nil, err
	}
	if start.Op == SandboxFileOpRename {
		if err := checkPath(start.To); err != nil {
			return SandboxFileInfo{}, nil, err
		}
	}
	start.Type = SandboxStreamMessageFiles
	again, seeker, from := data == nil, io.Seeker(nil), int64(0)
	if sk, ok := data.(io.Seeker); ok && data != nil {
		if at, err := sk.Seek(0, io.SeekCurrent); err == nil {
			again, seeker, from = true, sk, at
		}
	}
	first := time.Now()
	for attempt := 1; ; attempt++ {
		file, entries, heard, pumped, err := s.filesOnce(ctx, sandboxID, start, data, sink)
		wait, ok := streamRetry(err, attempt, first)
		if !ok || !again || heard {
			return file, entries, err
		}
		if seeker != nil {
			<-pumped // the last stream's copy of data has stopped reading it
			if _, serr := seeker.Seek(from, io.SeekStart); serr != nil {
				return file, entries, err
			}
		}
		if serr := sleepContext(ctx, wait); serr != nil {
			return SandboxFileInfo{}, nil, serr
		}
	}
}

func (s *Sandboxes) filesOnce(ctx context.Context, sandboxID string, start filesStart, data io.Reader, sink io.Writer) (file SandboxFileInfo, entries []SandboxFileInfo, heard bool, pumped <-chan struct{}, err error) {
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
	conn, err := s.open(ctx, streamPath(SandboxFilesPath, sandboxID))
	if err != nil {
		return file, nil, false, pumped, fileErrorOf(err)
	}
	defer conn.rwc.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.rwc.Close() })
	defer stop()
	message, _ := json.Marshal(start)
	if err := conn.write(wsText, message); err != nil {
		return file, nil, false, pumped, fileErrorOf(s.ended(ctx, err))
	}
	if start.Op == SandboxFileOpWrite {
		pumping = true
		go func() { conn.pump(data); close(copied) }()
	}
	defer close(conn.done)
	for {
		op, payload, err := conn.read(SandboxStreamMaxOutput + SandboxStreamMaxControl)
		if err != nil {
			return file, entries, heard, pumped, fileErrorOf(s.ended(ctx, err))
		}
		if op == wsBinary {
			heard = true
			if sink != nil && len(payload) > 0 {
				if _, err := sink.Write(payload); err != nil {
					return file, entries, heard, pumped, err
				}
			}
			continue
		}
		var m struct {
			streamMessage
			File    *SandboxFileInfo  `json:"file"`
			Entries []SandboxFileInfo `json:"entries"`
		}
		if json.Unmarshal(payload, &m) != nil {
			return file, entries, heard, pumped, fileError("cave_bad_request", "The sandbox sent a message this client cannot read.")
		}
		switch m.Type {
		case SandboxStreamMessageFile, SandboxStreamMessageDone:
			if m.File != nil {
				file = *m.File
			}
			_ = conn.close(1000)
			return file, entries, true, pumped, nil
		case SandboxStreamMessageEntries:
			heard = true
			entries = append(entries, m.Entries...)
		case SandboxStreamMessageError:
			return file, entries, heard, pumped, m.failure()
		}
		// A message type this client does not know is a later version's: it is read past.
	}
}

// streamMessage is what a files or dial stream's text message may say besides its own fields.
type streamMessage struct {
	Type       string `json:"type"`
	Code       string `json:"code"`
	Message    string `json:"message"`
	RetryAfter *int   `json:"retry_after"`
}

// failure is an error message as a *SandboxFileError.
func (m streamMessage) failure() error {
	e := fileError(m.Code, m.Message)
	if e.Code == "" {
		e.Code = "cave_internal"
	}
	if e.Message == "" {
		e.Message = SandboxStreamErrors[e.Code]
	}
	if e.Message == "" {
		e.Message = "The operation failed."
	}
	e.RetryAfter = m.RetryAfter
	return e
}

// fileErrorOf makes a stream's *SandboxExecError a *SandboxFileError; any other error is as it was.
func fileErrorOf(err error) error {
	var e *SandboxExecError
	if errors.As(err, &e) {
		var f *SandboxFileError
		if errors.As(err, &f) {
			return f
		}
		return &SandboxFileError{*e}
	}
	return err
}

func checkPath(path string) error {
	if !strings.HasPrefix(path, "/") || strings.IndexByte(path, 0) >= 0 || len(path) > SandboxMaxPath {
		return fileError("cave_bad_request", fmt.Sprintf("A sandbox's path is absolute, with no NUL byte, at most %d bytes.", SandboxMaxPath))
	}
	return nil
}

// SandboxConn is a TCP connection to a port on a sandbox's own loopback, through the relay
// (DialPort). Read answers what the sandbox sends and io.EOF once its side half-closes or the
// connection ends; a refusal (nothing listening: cave_code_computer_port_refused) or a broken stream
// is Read's *SandboxFileError. Write sends; CloseWrite says this side sends no more (the sandbox's
// may go on); Close ends the connection. One goroutine may Read while another Writes.
type SandboxConn struct {
	s       *Sandboxes
	ctx     context.Context
	conn    *wsConn
	stop    func() bool
	pending []byte
	err     error
}

// DialPort opens a TCP connection to port on a sandbox's own loopback (SandboxDialPath). Ending ctx
// ends the connection, as it ends Exec's stream.
func (s *Sandboxes) DialPort(ctx context.Context, sandboxID string, port int) (*SandboxConn, error) {
	if port < 1 || port > 65535 {
		return nil, fileError("cave_bad_request", "The port is a number from 1 to 65535.")
	}
	conn, err := s.open(ctx, strings.Replace(streamPath(SandboxDialPath, sandboxID), "{port}", strconv.Itoa(port), 1))
	if err != nil {
		return nil, fileErrorOf(err)
	}
	c := &SandboxConn{s: s, ctx: ctx, conn: conn}
	c.stop = context.AfterFunc(ctx, func() { _ = conn.rwc.Close() })
	return c, nil
}

func (c *SandboxConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		if c.err != nil {
			return 0, c.err
		}
		op, payload, err := c.conn.read(SandboxStreamMaxOutput + SandboxStreamMaxControl)
		if err != nil {
			var closed *wsClosed
			if errors.As(err, &closed) && closed.code == 1000 {
				c.err = io.EOF
			} else {
				c.err = fileErrorOf(c.s.ended(c.ctx, err))
			}
			continue
		}
		if op == wsBinary {
			c.pending = payload
			continue
		}
		var m streamMessage
		if json.Unmarshal(payload, &m) != nil {
			c.err = fileError("cave_bad_request", "The sandbox sent a message this client cannot read.")
			continue
		}
		switch m.Type {
		case SandboxStreamMessageCloseWrite:
			c.err = io.EOF
		case SandboxStreamMessageError:
			c.err = m.failure()
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

// Write sends p, in messages of at most SandboxStreamMaxInput bytes.
func (c *SandboxConn) Write(p []byte) (int, error) {
	for at := 0; at < len(p); at += SandboxStreamMaxInput {
		if err := c.conn.write(wsBinary, p[at:min(len(p), at+SandboxStreamMaxInput)]); err != nil {
			return at, fileErrorOf(c.s.ended(c.ctx, err))
		}
	}
	return len(p), nil
}

// CloseWrite says this side sends no more: a half close the sandbox's port sees as the end of its input.
func (c *SandboxConn) CloseWrite() error {
	return c.conn.write(wsText, []byte(`{"type":"`+SandboxStreamMessageCloseWrite+`"}`))
}

// Close ends the connection.
func (c *SandboxConn) Close() error {
	c.stop()
	_ = c.conn.close(1000)
	return c.conn.rwc.Close()
}
