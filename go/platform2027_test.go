package cavemancloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type platformRoundTripFunc func(*http.Request) (*http.Response, error)

func (f platformRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func jsonResponse(status int, body any, headers map[string]string) *http.Response {
	b, _ := json.Marshal(body)
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	for k, v := range headers {
		h.Set(k, v)
	}
	return &http.Response{
		StatusCode: status,
		Header:     h,
		Body:       io.NopCloser(bytes.NewReader(b)),
	}
}

func TestPlatform2027RoomsWithLease(t *testing.T) {
	var trace []string
	rt := platformRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		trace = append(trace, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/api/v1/code/rooms/eng/threads/thr_1/claim":
			return jsonResponse(200, map[string]any{"id": "thr_1", "lease_token": "tok_go", "status": "claimed"}, nil), nil
		case "/api/v1/code/rooms/eng/threads/thr_1/complete":
			return jsonResponse(200, map[string]any{"id": "thr_1", "status": "done"}, nil), nil
		case "/api/v1/code/rooms/eng/threads/thr_1/release":
			return jsonResponse(200, map[string]any{"id": "thr_1", "status": "ready"}, nil), nil
		default:
			return jsonResponse(404, map[string]any{"error": map[string]string{"code": "not_found", "message": "not found"}}, nil), nil
		}
	})

	rooms, err := NewRooms(PlatformOptions{ControlURL: "https://app.caveman.so", APIKey: "cave_live_go", Transport: rt})
	if err != nil {
		t.Fatalf("NewRooms: %v", err)
	}
	if err := rooms.WithLease(context.Background(), "eng", "thr_1", RoomLeaseOptions{TTLSeconds: 60}, func(_ context.Context, thr RoomThread) error {
		if thr.LeaseToken != "tok_go" {
			t.Fatalf("unexpected token: %s", thr.LeaseToken)
		}
		return nil
	}); err != nil {
		t.Fatalf("WithLease success: %v", err)
	}
	if strings.Join(trace, ",") != "POST /api/v1/code/rooms/eng/threads/thr_1/claim,POST /api/v1/code/rooms/eng/threads/thr_1/complete" {
		t.Fatalf("unexpected trace: %v", trace)
	}

	trace = nil
	boom := errors.New("worker crashed")
	err = rooms.WithLease(context.Background(), "eng", "thr_1", RoomLeaseOptions{TTLSeconds: 60}, func(context.Context, RoomThread) error {
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("expected boom, got %v", err)
	}
	if strings.Join(trace, ",") != "POST /api/v1/code/rooms/eng/threads/thr_1/claim,POST /api/v1/code/rooms/eng/threads/thr_1/release" {
		t.Fatalf("unexpected error trace: %v", trace)
	}
}

func TestPlatform2027WorkflowReplayUncertainAndPark(t *testing.T) {
	liveCalls := 0
	rt := platformRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		switch r.URL.Path {
		case "/api/v1/code/workflows/ship/runs":
			return jsonResponse(201, map[string]any{"id": "run_go", "session_id": "sess_go", "status": "running"}, nil), nil
		case "/api/v1/code/workflows/runs/run_go/steps/begin":
			switch body["step_key"] {
			case "cached":
				return jsonResponse(200, map[string]any{"action": "cached", "step_key": "cached", "result": map[string]any{"version": 7}}, nil), nil
			case "uncertain":
				return jsonResponse(200, map[string]any{"action": "uncertain", "step_key": "uncertain"}, nil), nil
			default:
				return jsonResponse(200, map[string]any{"action": "execute", "step_key": body["step_key"]}, nil), nil
			}
		case "/api/v1/code/workflows/runs/run_go/steps/complete":
			return jsonResponse(200, map[string]any{"ok": true}, nil), nil
		case "/api/v1/code/workflows/runs/run_go/wait":
			return jsonResponse(200, map[string]any{"id": "wait_go", "kind": body["kind"], "ask_id": body["ask_id"], "status": "waiting"}, nil), nil
		case "/api/v1/code/workflows/runs/run_go/finish":
			return jsonResponse(200, map[string]any{"id": "run_go", "status": body["status"]}, nil), nil
		default:
			return jsonResponse(404, map[string]any{"error": map[string]string{"code": "not_found", "message": "missing"}}, nil), nil
		}
	})

	wf, err := NewWorkflows(PlatformOptions{ControlURL: "http://127.0.0.1:8080", APIKey: "cave_live_go", Transport: rt})
	if err != nil {
		t.Fatalf("NewWorkflows: %v", err)
	}

	type stepRes struct {
		Version int `json:"version"`
	}
	run, out, parked, err := ExecuteWorkflow(context.Background(), wf, "ship", map[string]string{"env": "prod"}, "idem-1", func(ctx context.Context, wc *WorkflowContext, in map[string]string) (string, error) {
		c, err := WorkflowStep(ctx, wc, "cached", WorkflowStepOptions{}, func(context.Context) (stepRes, error) {
			t.Fatal("cached step should not execute")
			return stepRes{}, nil
		})
		if err != nil {
			return "", err
		}
		live, err := WorkflowStep(ctx, wc, "live", WorkflowStepOptions{Effect: "write"}, func(context.Context) (string, error) {
			liveCalls++
			return in["env"], nil
		})
		if err != nil {
			return "", err
		}
		return live + ":" + string(rune('0'+c.Version)), nil
	})
	if err != nil || parked != nil || run.Status != "completed" || out != "prod:7" || liveCalls != 1 {
		t.Fatalf("unexpected ExecuteWorkflow result: run=%+v out=%q parked=%+v err=%v liveCalls=%d", run, out, parked, err, liveCalls)
	}

	_, _, _, err = ExecuteWorkflow(context.Background(), wf, "ship", struct{}{}, "", func(ctx context.Context, wc *WorkflowContext, _ struct{}) (string, error) {
		return WorkflowStep(ctx, wc, "uncertain", WorkflowStepOptions{Effect: "external"}, func(context.Context) (string, error) {
			return "never", nil
		})
	})
	var unc *WorkflowUncertainEffectError
	if !errors.As(err, &unc) || unc.StepKey != "uncertain" {
		t.Fatalf("expected WorkflowUncertainEffectError, got %v", err)
	}

	parkedRun, _, waitRow, err := ExecuteWorkflow(context.Background(), wf, "ship", struct{}{}, "", func(ctx context.Context, wc *WorkflowContext, _ struct{}) (string, error) {
		return "", wc.WaitForApproval(ctx, "ask_go", "Approve release")
	})
	if err != nil || parkedRun.Status != "waiting" || waitRow == nil || waitRow.AskID != "ask_go" {
		t.Fatalf("expected parked wait, got run=%+v wait=%+v err=%v", parkedRun, waitRow, err)
	}
}

func TestPlatform2027ListenersAppsPoolsAndRetry(t *testing.T) {
	attempts := 0
	rt := platformRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/code/listeners":
			attempts++
			if attempts == 1 {
				return jsonResponse(429, map[string]any{"error": map[string]string{"code": "rate_limited", "message": "retry"}}, map[string]string{"Retry-After": "0"}), nil
			}
			return jsonResponse(201, map[string]any{"id": "lst_go", "name": "acme", "enabled": true}, nil), nil
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/code/apps/review/fork":
			return jsonResponse(201, map[string]any{"id": "app_go", "slug": "review-fork"}, nil), nil
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/code/apps/app_go/bridge":
			return jsonResponse(200, map[string]any{"path": "/notes.md", "text": "ok", "version": 2}, nil), nil
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/code/sessions/s1/computers":
			return jsonResponse(201, map[string]any{"id": "l1", "computer_id": "cmp_1", "role": "experiment"}, nil), nil
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/code/computers/unified":
			return jsonResponse(200, map[string]any{"computers": []map[string]any{{"id": "cmp_1", "scope": "org_pool"}}}, nil), nil
		default:
			return jsonResponse(404, map[string]any{"error": map[string]string{"code": "not_found", "message": "missing"}}, nil), nil
		}
	})
	opts := PlatformOptions{ControlURL: "https://app.caveman.so", APIKey: "cave_live_go", RetryDelay: time.Millisecond, Transport: rt}

	listeners, err := NewListeners(opts)
	if err != nil {
		t.Fatalf("NewListeners: %v", err)
	}
	pred := PredAll(PredIContains("from", "@acme.com"), PredGte("score", 5))
	lst, err := listeners.Create(context.Background(), CreateListenerInput{
		Name:       "acme",
		SourceKind: "webhook",
		FilterKind: "expression",
		FilterSpec: pred,
		TargetKind: "room_post",
		TargetID:   "thr_1",
	})
	if err != nil || lst.ID != "lst_go" || attempts != 2 {
		t.Fatalf("unexpected listener create: lst=%+v attempts=%d err=%v", lst, attempts, err)
	}

	apps, err := NewApps(opts)
	if err != nil {
		t.Fatalf("NewApps: %v", err)
	}
	forked, err := apps.Fork(context.Background(), "review", ForkAppInput{Slug: "review-fork"})
	if err != nil || forked.Slug != "review-fork" {
		t.Fatalf("Fork: %+v %v", forked, err)
	}
	bridge, err := NewAppBridge("app_go", opts)
	if err != nil {
		t.Fatalf("NewAppBridge: %v", err)
	}
	txt, ver, err := bridge.DriveRead(context.Background(), "/notes.md")
	if err != nil || txt != "ok" || ver != 2 {
		t.Fatalf("DriveRead: %q %d %v", txt, ver, err)
	}

	pools, err := NewComputerPools(opts)
	if err != nil {
		t.Fatalf("NewComputerPools: %v", err)
	}
	lease, err := pools.LeaseForSession(context.Background(), "s1", LeaseSessionComputerInput{Pool: "gpu", Role: "experiment"})
	if err != nil || lease.ComputerID != "cmp_1" {
		t.Fatalf("LeaseForSession: %+v %v", lease, err)
	}
	unified, err := pools.ListUnified(context.Background(), "org_pool")
	if err != nil || len(unified) != 1 {
		t.Fatalf("ListUnified: %+v %v", unified, err)
	}
}

func TestPlatform2027RejectsInsecureEndpoint(t *testing.T) {
	if _, err := NewRooms(PlatformOptions{ControlURL: "http://example.com", APIKey: "cave_live_go"}); err == nil {
		t.Fatal("expected insecure remote HTTP endpoint to fail")
	}
}
