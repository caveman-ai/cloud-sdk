package cavemancloud_test

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	cavemancloud "github.com/caveman-ai/sdk-go"
)

// TestSandboxesEndToEnd drives a real control-api and relay (the Caveman sandbox test harness
// runs it with CAVE_SANDBOX_E2E_API, _RELAY and _KEY, a code:run key): make a sandbox, run commands
// in it, write and read a file in it (in CAVE_SANDBOX_E2E_DIR, /tmp when unset), reach a port in it
// (CAVE_SANDBOX_E2E_PORT, when set: one that answers what it reads upper-cased), take a snapshot of
// it, restore it, make a new sandbox from it, put it to sleep, wake it, delete it. The quickstart's
// Go snippet is this test's body.
func TestSandboxesEndToEnd(t *testing.T) {
	api, relay, key := os.Getenv("CAVE_SANDBOX_E2E_API"), os.Getenv("CAVE_SANDBOX_E2E_RELAY"), os.Getenv("CAVE_SANDBOX_E2E_KEY")
	if api == "" || key == "" {
		t.Skip("set CAVE_SANDBOX_E2E_API and CAVE_SANDBOX_E2E_KEY (the Caveman sandbox test harness runs it)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	// quickstart:go
	sandboxes, err := cavemancloud.NewSandboxes(cavemancloud.SandboxesOptions{ControlURL: api, RelayURL: relay, APIKey: key})
	check(err)
	name := "quickstart-go"
	box, err := sandboxes.Create(ctx, cavemancloud.SandboxesCreateInput{Name: &name})
	check(err)
	_, err = sandboxes.Wait(ctx, box.Id, cavemancloud.SandboxStateRunning)
	check(err)
	result, err := sandboxes.Run(ctx, box.Id, []string{"sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 3"}, nil)
	check(err)
	// result.ExitCode is 3, result.Stdout "hello from the sandbox\n", result.Stderr "careful\n"
	_, err = sandboxes.Delete(ctx, box.Id)
	check(err)
	// quickstart:end
	if result.ExitCode != 3 || string(result.Stdout) != "hello from the sandbox\n" || string(result.Stderr) != "careful\n" {
		t.Fatalf("run = %d %q %q", result.ExitCode, result.Stdout, result.Stderr)
	}

	// The rest of the lifecycle on a second sandbox: stdin, streamed output, the list, sleep, a
	// command refused while it sleeps, resume, delete, and the sandbox gone.
	name = "e2e-go"
	box2, err := sandboxes.Create(ctx, cavemancloud.SandboxesCreateInput{Name: &name})
	if err != nil || !box2.Bare {
		t.Fatalf("create = %+v %v", box2, err)
	}
	if _, err := sandboxes.Wait(ctx, box2.Id, cavemancloud.SandboxStateRunning); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	code, err := sandboxes.Exec(ctx, box2.Id, []string{"cat"}, cavemancloud.ExecOptions{Stdin: strings.NewReader("stdin reaches it"), Stdout: &out})
	if err != nil || code != 0 || out.String() != "stdin reaches it" {
		t.Fatalf("cat = %d %q %v", code, out.String(), err)
	}
	// A command quiet for longer than the relay's ping interval (the lab pings every second): the
	// client answers the pings, so the stream stays open until the command's exit.
	if res, err := sandboxes.Run(ctx, box2.Id, []string{"sh", "-c", "sleep 3; echo still here"}, nil); err != nil || res.ExitCode != 0 || string(res.Stdout) != "still here\n" {
		t.Fatalf("a quiet command = %+v %v", res, err)
	}
	// A file written is read back and listed.
	dir := cmp.Or(os.Getenv("CAVE_SANDBOX_E2E_DIR"), "/tmp")
	path := dir + "/e2e-go-" + box2.Id + ".txt"
	if info, err := sandboxes.WriteFile(ctx, box2.Id, path, strings.NewReader("a file through the relay\n"), cavemancloud.WriteFileOptions{Mode: 0o600}); err != nil || info.Size != 25 || info.Mode != 0o600 {
		t.Fatalf("WriteFile = %+v, %v", info, err)
	}
	if data, err := sandboxes.ReadFile(ctx, box2.Id, path, cavemancloud.FileOptions{}); err != nil || string(data) != "a file through the relay\n" {
		t.Fatalf("ReadFile = %q, %v", data, err)
	}
	entries, err := sandboxes.ListFiles(ctx, box2.Id, dir, cavemancloud.FileOptions{})
	listed := false
	for _, e := range entries {
		listed = listed || dir+"/"+e.Name == path
	}
	if err != nil || !listed {
		t.Fatalf("ListFiles(%s) = %d entries, %v; want %s among them", dir, len(entries), err, path)
	}
	// A command's options: its environment and folder (the file is there); a signal ends it.
	out.Reset()
	if code, err := sandboxes.Exec(ctx, box2.Id, []string{"sh", "-c", `echo "$GREETING"; ls`}, cavemancloud.ExecOptions{Env: map[string]string{"GREETING": "hello env"}, Cwd: dir, Stdout: &out}); err != nil || code != 0 ||
		!strings.HasPrefix(out.String(), "hello env\n") || !strings.Contains(out.String(), filepath.Base(path)) {
		t.Fatalf("a command with env and cwd = %d %q %v", code, out.String(), err)
	}
	command := &cavemancloud.SandboxCommand{}
	check(command.SendSignal(cavemancloud.SandboxSignalInt))
	if code, err := sandboxes.Exec(ctx, box2.Id, []string{"sleep", "30"}, cavemancloud.ExecOptions{Control: command}); err != nil || code != 130 {
		t.Fatalf("a command sent INT = %d %v; want 130", code, err)
	}
	if err := sandboxes.RemoveFile(ctx, box2.Id, path, false, cavemancloud.FileOptions{}); err != nil {
		t.Fatal(err)
	}
	var missing *cavemancloud.SandboxFileError
	if _, err := sandboxes.ReadFile(ctx, box2.Id, path, cavemancloud.FileOptions{}); !errors.As(err, &missing) || missing.Code != "cave_code_computer_file_not_found" {
		t.Fatalf("a read of the removed file = %v; want cave_code_computer_file_not_found", err)
	}
	if port := os.Getenv("CAVE_SANDBOX_E2E_PORT"); port != "" {
		n, _ := strconv.Atoi(port)
		conn, err := sandboxes.DialPort(ctx, box2.Id, n)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(conn, "hello port"); err != nil {
			t.Fatal(err)
		}
		if err := conn.CloseWrite(); err != nil {
			t.Fatal(err)
		}
		if back, err := io.ReadAll(conn); err != nil || string(back) != "HELLO PORT" {
			t.Fatalf("the port answered %q, %v", back, err)
		}
		_ = conn.Close()
	}
	// A snapshot: taken and ready, listed, restored into it, a new sandbox made from it (a fork) that
	// runs a command, then deleted.
	snapName := "e2e-go"
	snap, err := sandboxes.Snapshot(ctx, box2.Id, cavemancloud.SandboxesSnapshotInput{Name: &snapName})
	if err != nil || snap.State != cavemancloud.SnapshotStateTaking || snap.ComputerId != box2.Id {
		t.Fatalf("Snapshot = %+v, %v", snap, err)
	}
	if snap, err = sandboxes.WaitForSnapshot(ctx, box2.Id, snap.Id); err != nil || snap.State != cavemancloud.SnapshotStateReady {
		t.Fatalf("WaitForSnapshot = %+v, %v", snap, err)
	}
	if snaps, err := sandboxes.ListSnapshots(ctx, box2.Id); err != nil || len(snaps.Snapshots) != 1 || snaps.Snapshots[0].Id != snap.Id {
		t.Fatalf("ListSnapshots = %+v, %v", snaps, err)
	}
	if _, err := sandboxes.Restore(ctx, box2.Id, snap.Id); err != nil {
		t.Fatal(err)
	}
	if got, err := sandboxes.WaitForRestore(ctx, box2.Id, snap.Id); err != nil || got.Restore.State != cavemancloud.RestoreStateRestored {
		t.Fatalf("WaitForRestore = %+v, %v", got, err)
	}
	if _, err := sandboxes.Wait(ctx, box2.Id, cavemancloud.SandboxStateRunning); err != nil {
		t.Fatal(err)
	}
	forkName := "e2e-go-fork"
	child, err := sandboxes.Fork(ctx, box2.Id, snap.Id, cavemancloud.SandboxesForkInput{Name: &forkName})
	if err != nil || !child.Bare || child.Id == box2.Id {
		t.Fatalf("Fork = %+v, %v", child, err)
	}
	if _, err := sandboxes.Wait(ctx, child.Id, cavemancloud.SandboxStateRunning); err != nil {
		t.Fatal(err)
	}
	if res, err := sandboxes.Run(ctx, child.Id, []string{"echo", "forked"}, nil); err != nil || string(res.Stdout) != "forked\n" {
		t.Fatalf("a command in the fork = %+v %v", res, err)
	}
	if _, err := sandboxes.Delete(ctx, child.Id); err != nil {
		t.Fatal(err)
	}
	if d, err := sandboxes.DeleteSnapshot(ctx, box2.Id, snap.Id); err != nil || (d.State != cavemancloud.SnapshotStateDeleting && d.State != cavemancloud.SnapshotStateDeleted) {
		t.Fatalf("DeleteSnapshot = %+v, %v", d, err)
	}
	list, err := sandboxes.List(ctx, cavemancloud.SandboxesListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range list.Computers {
		found = found || c.Id == box2.Id
	}
	if !found {
		t.Fatalf("the list %+v has no %s", list, box2.Id)
	}
	if _, err := sandboxes.Sleep(ctx, box2.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := sandboxes.Wait(ctx, box2.Id, cavemancloud.SandboxStateSuspended); err != nil {
		t.Fatal(err)
	}
	var refused *cavemancloud.SandboxExecError
	if _, err := sandboxes.Run(ctx, box2.Id, []string{"true"}, nil); !errors.As(err, &refused) || refused.Code != "cave_code_computer_not_running" || refused.Status != 409 {
		t.Fatalf("a command in a sleeping sandbox = %v; want cave_code_computer_not_running", err)
	}
	if _, err := sandboxes.Resume(ctx, box2.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := sandboxes.Wait(ctx, box2.Id, cavemancloud.SandboxStateRunning); err != nil {
		t.Fatal(err)
	}
	if res, err := sandboxes.Run(ctx, box2.Id, []string{"echo", "awake"}, nil); err != nil || string(res.Stdout) != "awake\n" {
		t.Fatalf("after resume = %+v %v", res, err)
	}
	if _, err := sandboxes.Delete(ctx, box2.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := sandboxes.Wait(ctx, box2.Id, cavemancloud.SandboxStateDeleted); err != nil {
		t.Fatalf("wait deleted = %v", err)
	}
	var gone *cavemancloud.Error
	if _, err := sandboxes.Get(ctx, box2.Id); !errors.As(err, &gone) || gone.Code != cavemancloud.SandboxErrorNotFound {
		t.Fatalf("get after delete = %v", err)
	}
}

// TestSandboxesWaitingForRoom reads the sandbox the lab made larger than its one host
// (CAVE_SANDBOX_E2E_ROOM): it says why it is not running in the vocabulary's sentence
// (public/sdk/parity/sandbox-reasons.json), never failed, and a wait for it to run goes on until its
// deadline rather than ending, as one that passes by itself.
func TestSandboxesWaitingForRoom(t *testing.T) {
	api, relay, key, room := os.Getenv("CAVE_SANDBOX_E2E_API"), os.Getenv("CAVE_SANDBOX_E2E_RELAY"), os.Getenv("CAVE_SANDBOX_E2E_KEY"), os.Getenv("CAVE_SANDBOX_E2E_ROOM")
	if api == "" || key == "" || room == "" {
		t.Skip("set CAVE_SANDBOX_E2E_API, CAVE_SANDBOX_E2E_KEY and CAVE_SANDBOX_E2E_ROOM (the Caveman sandbox test harness runs it)")
	}
	raw, err := os.ReadFile(filepath.Join("..", "parity", "sandbox-reasons.json"))
	if err != nil {
		t.Fatal(err)
	}
	var reasons struct {
		Codes map[string]struct {
			Sentence string `json:"sentence"`
		} `json:"codes"`
	}
	if err := json.Unmarshal(raw, &reasons); err != nil {
		t.Fatal(err)
	}
	sentence := reasons.Codes[cavemancloud.SandboxReasonWaitingForCapacity].Sentence
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	sandboxes, err := cavemancloud.NewSandboxes(cavemancloud.SandboxesOptions{ControlURL: api, RelayURL: relay, APIKey: key})
	if err != nil {
		t.Fatal(err)
	}
	box, err := sandboxes.Get(ctx, room)
	switch {
	case err != nil:
		t.Fatal(err)
	case box.ObservedReason == nil || *box.ObservedReason != sentence || box.ObservedState == cavemancloud.SandboxStateFailed:
		t.Fatalf("the sandbox reads %s, %v; want the room sentence", box.ObservedState, box.ObservedReason)
	case box.ObservedReasonCode == nil || *box.ObservedReasonCode != cavemancloud.SandboxReasonWaitingForCapacity:
		t.Fatalf("its code is %v; want %s", box.ObservedReasonCode, cavemancloud.SandboxReasonWaitingForCapacity)
	}
	short, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	var ended *cavemancloud.SandboxStateError
	if _, err := sandboxes.Wait(short, room, cavemancloud.SandboxStateRunning); errors.As(err, &ended) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a wait for it to run = %v; want it to go on until its deadline", err)
	}
}
