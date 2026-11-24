package cavemancloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func snapshotOf(t *testing.T, raw json.RawMessage) CodeComputerSnapshot {
	t.Helper()
	var s CodeComputerSnapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// A sandbox's snapshot calls send the key, the route and the body, and read the recorded answers
// (the lab's: a take, ready, listed, restored, a fork made from it, deleted) into the generated
// types; a refusal is an *Error with the API's code.
func TestSandboxSnapshotCallsSpeakTheRecordedWire(t *testing.T) {
	_, s, w := newFake(t)
	ctx := context.Background()
	taken := snapshotOf(t, w.Rest["snapshot"].Answer)
	sandbox := taken.ComputerId
	name := "wire"
	snap, err := s.Snapshot(ctx, sandbox, SandboxesSnapshotInput{Name: &name})
	if err != nil || snap.Id != taken.Id || snap.State != SnapshotStateTaking || snap.Name != "wire" || snap.ReasonCode != nil || snap.Restore.State != RestoreStateNone {
		t.Fatalf("snapshot = %+v %v", snap, err)
	}
	ready, err := s.GetSnapshot(ctx, sandbox, snap.Id)
	if err != nil || ready.State != SnapshotStateReady || ready.ReadyAt == nil {
		t.Fatalf("get = %+v %v; want ready", ready, err)
	}
	list, err := s.ListSnapshots(ctx, sandbox)
	if err != nil || len(list.Snapshots) != 1 || list.Snapshots[0].Id != snap.Id {
		t.Fatalf("list = %+v %v", list, err)
	}
	restoring, err := s.Restore(ctx, sandbox, snap.Id)
	if err != nil || restoring.Restore.State != RestoreStateRestoring || restoring.Restore.AskedAt == nil {
		t.Fatalf("restore = %+v %v", restoring, err)
	}
	if got, err := s.GetSnapshot(ctx, sandbox, snap.Id); err != nil || got.Restore.State != RestoreStateRestored || got.Restore.DoneAt == nil {
		t.Fatalf("get after the restore = %+v %v; want restored", got, err)
	}
	forkName, never := "wire-fork", 0
	child, err := s.Fork(ctx, sandbox, snap.Id, SandboxesForkInput{Name: &forkName, SleepAfterSeconds: &never})
	if err != nil || child.Id == "" || child.Id == sandbox || !child.Bare || child.Name != "wire-fork" || child.DesiredState != "running" {
		t.Fatalf("fork = %+v %v", child, err)
	}
	if d, err := s.DeleteSnapshot(ctx, sandbox, snap.Id); err != nil || d.State != SnapshotStateDeleting {
		t.Fatalf("delete = %+v %v; want deleting", d, err)
	}
	if d, err := s.DeleteSnapshot(ctx, sandbox, snap.Id); err != nil || d.State != SnapshotStateDeleted || d.Id != snap.Id {
		t.Fatalf("delete again = %+v %v; want it, deleted", d, err)
	}
	for _, c := range []struct {
		name string
		call func() error
		code string
		want int
	}{
		{"get_snapshot_unknown", func() error {
			_, err := s.GetSnapshot(ctx, sandbox, w.Rest["get_snapshot_unknown"].Path[strings.LastIndexByte(w.Rest["get_snapshot_unknown"].Path, '/')+1:])
			return err
		}, SandboxErrorNotFound, 404},
		{"fork_deleted", func() error { _, err := s.Fork(ctx, sandbox, snap.Id, SandboxesForkInput{}); return err }, SandboxErrorCodeComputerSnapshotNotReady, 409},
	} {
		var e *Error
		if err := c.call(); !errors.As(err, &e) || e.Code != c.code || e.Status != c.want || e.Message == "" || e.RequestID == "" {
			t.Errorf("%s = %#v; want %s %d with its message and request id", c.name, err, c.code, c.want)
		}
	}
}

// A snapshot's delete is safe to ask again (the contract's x-idempotent): a 503 is asked again; a
// take, a restore and a fork, which the server may have acted on, are asked once.
func TestSandboxSnapshotsRetryOnlyTheDelete(t *testing.T) {
	w := loadWire(t)
	deleting := w.Rest["delete_snapshot"].Answer
	var mu sync.Mutex
	counts := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:]
		mu.Lock()
		counts[key]++
		n := counts[key]
		mu.Unlock()
		if r.Method == "DELETE" && n > 1 {
			_, _ = rw.Write(deleting)
			return
		}
		rw.WriteHeader(503)
		fmt.Fprint(rw, `{"error":{"type":"cave_gateway_error","code":"cave_unavailable","message":"Ask again.","request_id":"r"}}`)
	}))
	defer srv.Close()
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	s.pause = func(context.Context, time.Duration) error { return nil }
	ctx := context.Background()
	if _, err := s.DeleteSnapshot(ctx, "x", "snap"); err != nil || counts["DELETE snap"] != 2 {
		t.Fatalf("delete after a 503 = %v after %d asks; want it asked again", err, counts["DELETE snap"])
	}
	for name, call := range map[string]func() error{
		"POST snapshots": func() error { _, err := s.Snapshot(ctx, "x", SandboxesSnapshotInput{}); return err },
		"POST restore":   func() error { _, err := s.Restore(ctx, "x", "snap"); return err },
		"POST fork":      func() error { _, err := s.Fork(ctx, "x", "snap", SandboxesForkInput{}); return err },
	} {
		var e *Error
		if err := call(); !errors.As(err, &e) || e.Status != 503 || counts[name] != 1 {
			t.Errorf("%s after a 503 = %v after %d asks; want it asked once", name, err, counts[name])
		}
	}
}

// snapshotSequence serves GET of one snapshot as the answers given, in turn, the last again.
func snapshotSequence(t *testing.T, answers ...map[string]any) (*Sandboxes, *int) {
	t.Helper()
	var mu sync.Mutex
	reads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/v1/code/computers/box/snapshots/snap" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		mu.Lock()
		a := answers[min(reads, len(answers)-1)]
		reads++
		mu.Unlock()
		_ = json.NewEncoder(rw).Encode(a)
	}))
	t.Cleanup(srv.Close)
	s, err := NewSandboxes(SandboxesOptions{ControlURL: srv.URL, APIKey: "cave_live_wire"})
	if err != nil {
		t.Fatal(err)
	}
	s.pause = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	return s, &reads
}

func snapshotAnswer(state, restore, reason, restoreReason string) map[string]any {
	code := func(r string) any {
		if r == "" {
			return nil
		}
		return "internal_error"
	}
	return map[string]any{"id": "snap", "organization_id": "org", "computer_id": "box", "name": "", "size": "", "state": state, "reason_code": code(reason), "reason": reason,
		"created_at": "2026-11-20T00:00:00Z", "ready_at": nil,
		"restore": map[string]any{"state": restore, "asked_at": nil, "done_at": nil, "reason_code": code(restoreReason), "reason": restoreReason}}
}

// WaitForSnapshot reads until the snapshot is ready; one that failed, or is deleted, ends the wait
// with a *SnapshotStateError that says why; ctx bounds it. WaitForRestore reads until its restore
// ended restored; one that failed, or none asked, ends it so.
func TestSandboxSnapshotWaits(t *testing.T) {
	ctx := context.Background()
	s, reads := snapshotSequence(t, snapshotAnswer("taking", "none", "", ""), snapshotAnswer("taking", "none", "", ""), snapshotAnswer("ready", "none", "", ""))
	if got, err := s.WaitForSnapshot(ctx, "box", "snap"); err != nil || got.State != SnapshotStateReady || *reads != 3 {
		t.Fatalf("wait = %+v %v after %d reads; want ready after 3", got, err, *reads)
	}
	for _, c := range []struct {
		name    string
		answer  map[string]any
		restore bool
		says    string
	}{
		{"failed", snapshotAnswer("failed", "none", "Cloud could not take this snapshot (reference 0a1b2c3d).", ""), false, "reference 0a1b2c3d"},
		{"deleted", snapshotAnswer("deleted", "none", "", ""), false, "is deleted"},
		{"restore failed", snapshotAnswer("ready", "failed", "", "This snapshot is kept on another host."), true, "another host"},
		{"no restore", snapshotAnswer("ready", "none", "", ""), true, "no restore"},
	} {
		s, _ := snapshotSequence(t, c.answer)
		var err error
		if c.restore {
			_, err = s.WaitForRestore(ctx, "box", "snap")
		} else {
			_, err = s.WaitForSnapshot(ctx, "box", "snap")
		}
		var e *SnapshotStateError
		if !errors.As(err, &e) || e.Restore != c.restore || !strings.Contains(err.Error(), c.says) {
			t.Errorf("%s: %v; want a SnapshotStateError saying %q", c.name, err, c.says)
		}
	}
	s, _ = snapshotSequence(t, snapshotAnswer("ready", "restoring", "", ""), snapshotAnswer("ready", "restored", "", ""))
	if got, err := s.WaitForRestore(ctx, "box", "snap"); err != nil || got.Restore.State != RestoreStateRestored {
		t.Fatalf("restore wait = %+v %v", got, err)
	}
	s, _ = snapshotSequence(t, snapshotAnswer("taking", "none", "", ""))
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	s.pause = sleepContext
	if _, err := s.WaitForSnapshot(short, "box", "snap"); err == nil || !strings.Contains(err.Error(), "not yet done") {
		t.Fatalf("a wait past its context = %v; want it ended, saying the snapshot is not yet done", err)
	}
}
