package cavemancloud

// A sandbox's snapshots: a copy of its disk the caller takes (Snapshot), reads (GetSnapshot,
// ListSnapshots), restores into the sandbox it was taken of (Restore), makes a new sandbox from
// (Fork) and deletes (DeleteSnapshot), each a plain call generated from the contract
// (sandboxes_generated.go). A take and a restore are asked, then done by Caveman Cloud: this file
// waits for each to end (WaitForSnapshot, WaitForRestore). A snapshot is its taker's alone: the
// service account whose key took it, and no other key, sees it.

import (
	"context"
	"fmt"
	"time"
)

// Snapshot states (CodeComputerSnapshot.State) and restore states (its Restore.State).
const (
	SnapshotStateTaking   = "taking"
	SnapshotStateReady    = "ready"
	SnapshotStateFailed   = "failed"
	SnapshotStateDeleting = "deleting"
	SnapshotStateDeleted  = "deleted"

	RestoreStateNone      = "none"
	RestoreStateRestoring = "restoring"
	RestoreStateRestored  = "restored"
	RestoreStateFailed    = "failed"
)

// SnapshotStateError is a wait for a snapshot that cannot end as it waits: a take that failed, or a
// snapshot deleted, while waiting for it to be ready; a restore that failed, or none asked, while
// waiting for one to end restored. Snapshot is the snapshot as last read.
type SnapshotStateError struct {
	SandboxID string
	Restore   bool // the wait was for a restore
	Snapshot  CodeComputerSnapshot
}

func (e *SnapshotStateError) Error() string {
	s := e.Snapshot
	switch {
	case e.Restore && s.Restore.State == RestoreStateNone:
		return fmt.Sprintf("snapshot %s of sandbox %s: no restore of it was asked", s.Id, e.SandboxID)
	case e.Restore:
		return fmt.Sprintf("snapshot %s of sandbox %s: its restore %s: %s", s.Id, e.SandboxID, s.Restore.State, s.Restore.Reason)
	case s.State == SnapshotStateFailed:
		return fmt.Sprintf("snapshot %s of sandbox %s failed: %s", s.Id, e.SandboxID, s.Reason)
	default:
		return fmt.Sprintf("snapshot %s of sandbox %s is %s, so it will not be ready", s.Id, e.SandboxID, s.State)
	}
}

// WaitForSnapshot reads snapshot snapshotID of sandbox sandboxID until it is ready, and answers it
// then. A take that failed (its ReasonCode and Reason say why) and a snapshot being deleted or
// deleted end the wait with a *SnapshotStateError. ctx bounds the wait; with no deadline it is 10
// minutes. Reads start a quarter of a second apart and double, to the client's poll interval.
func (s *Sandboxes) WaitForSnapshot(ctx context.Context, sandboxID, snapshotID string) (CodeComputerSnapshot, error) {
	return s.waitSnapshot(ctx, sandboxID, snapshotID, false)
}

// WaitForRestore reads snapshot snapshotID of sandbox sandboxID until the restore asked of it
// (Restore) ended restored, and answers it then. One that failed (Restore.ReasonCode and
// Restore.Reason say why: snapshot_elsewhere, the sandbox moved from the host keeping it; fork it
// instead), and a snapshot no restore was asked of, end the wait with a *SnapshotStateError. ctx
// bounds the wait as WaitForSnapshot's does.
func (s *Sandboxes) WaitForRestore(ctx context.Context, sandboxID, snapshotID string) (CodeComputerSnapshot, error) {
	return s.waitSnapshot(ctx, sandboxID, snapshotID, true)
}

func (s *Sandboxes) waitSnapshot(ctx context.Context, sandboxID, snapshotID string, restore bool) (CodeComputerSnapshot, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
	}
	interval := min(250*time.Millisecond, s.poll)
	for {
		snap, err := s.GetSnapshot(ctx, sandboxID, snapshotID)
		if err != nil {
			return snap, err
		}
		done, ended := snapshotWaitOutcome(snap, restore)
		switch {
		case done:
			return snap, nil
		case ended:
			return snap, &SnapshotStateError{SandboxID: sandboxID, Restore: restore, Snapshot: snap}
		}
		if err := s.pause(ctx, interval); err != nil {
			what := "snapshot " + snap.State
			if restore {
				what = "restore " + snap.Restore.State
			}
			return snap, fmt.Errorf("snapshot %s of sandbox %s: %s, not yet done: %w", snapshotID, sandboxID, what, err)
		}
		interval = min(interval*2, s.poll)
	}
}

// snapshotWaitOutcome says whether a wait for snap (its take, or with restore its restore) is done,
// or has ended without being done.
func snapshotWaitOutcome(snap CodeComputerSnapshot, restore bool) (done, ended bool) {
	if restore {
		switch snap.Restore.State {
		case RestoreStateRestored:
			return true, false
		case RestoreStateRestoring:
			return false, false
		}
		return false, true // failed, or none asked
	}
	switch snap.State {
	case SnapshotStateReady:
		return true, false
	case SnapshotStateTaking:
		return false, false
	}
	return false, true // failed, deleting, deleted
}
