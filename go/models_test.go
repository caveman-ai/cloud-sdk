package cavemancloud

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

// TestGatewayParityFixtures replays the route/trim/compact operations of the
// shared SDK parity fixtures, which the TypeScript and Python SDKs run too.
func TestGatewayParityFixtures(t *testing.T) {
	raw, err := os.ReadFile("../parity/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	var config struct {
		APIKey          string `json:"api_key"`
		Agent           string `json:"agent"`
		DefaultWorkflow string `json:"default_workflow"`
		Retention       string `json:"retention"`
		User            string `json:"user"`
	}
	type operation struct {
		Name     string          `json:"name"`
		Input    map[string]any  `json:"input"`
		Status   int             `json:"status"`
		Response json.RawMessage `json:"response"`
		Expect   struct {
			Wire struct {
				Method  string         `json:"method"`
				Path    string         `json:"path"`
				Headers string         `json:"headers"`
				Body    map[string]any `json:"body"`
			} `json:"wire"`
			ResultFrom string         `json:"result_from"`
			Result     map[string]any `json:"result"`
		} `json:"expect"`
	}
	var operations []json.RawMessage
	if json.Unmarshal(fixtures["config"], &config) != nil || json.Unmarshal(fixtures["operations"], &operations) != nil {
		t.Fatal("fixtures do not decode")
	}
	ran := 0
	for _, encoded := range operations {
		var name struct{ Name string }
		_ = json.Unmarshal(encoded, &name)
		if name.Name != "route" && name.Name != "trim" && name.Name != "compact" && name.Name != "trim_allowance_exhausted" {
			continue
		}
		var op operation
		if err := json.Unmarshal(encoded, &op); err != nil {
			t.Fatalf("%s: %v", name.Name, err)
		}
		ran++
		t.Run(op.Name, func(t *testing.T) {
			var wantHeaders map[string]string
			if err := json.Unmarshal(fixtures[op.Expect.Wire.Headers], &wantHeaders); err != nil {
				t.Fatal(err)
			}
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != op.Expect.Wire.Method || r.URL.Path != op.Expect.Wire.Path {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
				}
				for name, want := range wantHeaders {
					if got := r.Header.Get(name); got != want {
						t.Errorf("header %s = %q, want %q", name, got, want)
					}
				}
				for name := range r.Header {
					if lower := strings.ToLower(name); strings.HasPrefix(lower, "x-cave-") && wantHeaders[lower] == "" {
						t.Errorf("unexpected header %s", name)
					}
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !reflect.DeepEqual(body, op.Expect.Wire.Body) {
					t.Errorf("body = %v (%v), want %v", body, err, op.Expect.Wire.Body)
				}
				if op.Status != 0 {
					w.WriteHeader(op.Status)
				}
				_, _ = w.Write(op.Response)
			}))
			defer server.Close()
			gateway, err := NewGateway(GatewayOptions{BaseURL: server.URL, APIKey: config.APIKey, Agent: config.Agent, Workflow: config.DefaultWorkflow, Retention: config.Retention, User: config.User})
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			var got any
			switch op.Name {
			case "route":
				request, _ := op.Input["request"].(map[string]any)
				result, err := gateway.Route(ctx, request)
				if err != nil || result.Model == "" || result.RouterVersion == "" {
					t.Fatalf("result=%+v err=%v", result, err)
				}
				got = result.Raw
			case "trim", "trim_allowance_exhausted":
				level, _ := op.Input["level"].(string)
				result, err := gateway.Trim(ctx, TrimRequest{Input: op.Input["payload"].(string), Query: op.Input["query"].(string), Level: level})
				var failure *Error
				if errors.As(err, &failure) {
					got = map[string]any{"error": map[string]any{"status": failure.Status, "code": failure.Code, "message": failure.Message, "request_id": failure.RequestID}}
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				handle := any(nil)
				if result.RecoveryHandle != "" {
					handle = result.RecoveryHandle
				}
				got = map[string]any{"output": result.Output, "tokens_before": result.TokensBefore, "tokens_after": result.TokensAfter, "recovery_handle": handle, "model": result.Model}
			case "compact":
				messages, _ := op.Input["messages"].([]any)
				result, err := gateway.Compact(ctx, CompactRequest{Messages: messages, BudgetTokens: int(op.Input["budget_tokens"].(float64))})
				if err != nil {
					t.Fatal(err)
				}
				handles := any(nil)
				if result.RecoveryHandles != nil {
					handles = result.RecoveryHandles
				}
				got = map[string]any{"messages": result.Messages, "tokens_before": result.TokensBefore, "tokens_after": result.TokensAfter, "recovery_handles": handles, "model": result.Model}
			}
			if requests != 1 {
				t.Fatalf("requests = %d, want 1", requests)
			}
			want := any(op.Expect.Result)
			if op.Expect.ResultFrom == "response" {
				want = op.Response
			}
			if canonical(t, got) != canonical(t, want) {
				t.Fatalf("result = %s\nwant     %s", canonical(t, got), canonical(t, want))
			}
		})
	}
	if ran != 4 {
		t.Fatalf("replayed %d gateway fixtures, want 4", ran)
	}
}

// canonical re-encodes a value through a generic decode so key order and
// number types do not matter.
func canonical(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var generic any
	if err = json.Unmarshal(encoded, &generic); err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(generic)
	return string(encoded)
}

func TestGatewayRefusesCallerMistakesAndReadsTheRequestIDHeader(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("X-Cave-Request-Id", "req-502")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream unavailable"))
	}))
	defer server.Close()
	if _, err := NewGateway(GatewayOptions{BaseURL: server.URL + "?q=1", APIKey: "k", Agent: "a"}); err == nil {
		t.Fatal("query in BaseURL accepted")
	}
	gateway, err := NewGateway(GatewayOptions{BaseURL: server.URL + "/", APIKey: "k", Agent: "a"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var invalid *Error
	if _, err = gateway.Trim(ctx, TrimRequest{Input: "x", Query: "  "}); !errors.As(err, &invalid) || invalid.Code != "cave_request_invalid" {
		t.Fatalf("blank query: %v", err)
	}
	if _, err = gateway.Compact(ctx, CompactRequest{BudgetTokens: 0}); !errors.As(err, &invalid) || invalid.Code != "cave_request_invalid" {
		t.Fatalf("zero budget: %v", err)
	}
	if requests != 0 {
		t.Fatal("caller mistakes reached the network")
	}
	_, err = gateway.Route(ctx, map[string]any{"text": "query"})
	var failure *Error
	if !errors.As(err, &failure) || failure.Status != 502 || failure.Code != "cave_request_failed" || failure.Message != "upstream unavailable" || failure.RequestID != "req-502" {
		t.Fatalf("err = %#v", err)
	}
}
