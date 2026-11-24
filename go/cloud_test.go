package cavemancloud

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResourceTransport(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/v1/projects/"+project+"/cloud/operations/datasets.create" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("Idempotency-Key") != "same-request" || r.Header.Get("X-Cave-Operation-Contract") != operations["datasets.create"].contract {
			t.Error("missing scope/contract/retry headers")
		}
		_ = json.NewEncoder(w).Encode(Result[map[string]any]{SchemaVersion: 1, Operation: "datasets.create", Version: operations["datasets.create"].version, ContractSHA256: operations["datasets.create"].contract, OK: true, Status: "completed", Data: map[string]any{"id": "saved"}})
	}))
	defer server.Close()
	client, err := New(Options{ControlURL: server.URL, AccessToken: "secret", ProjectID: project})
	if err != nil {
		t.Fatal(err)
	}
	input := DatasetsCreateInput{Name: "Cases"}
	if _, err := client.Datasets.Create(context.Background(), input, CallOptions{}); err == nil || calls != 0 {
		t.Fatal("unkeyed write reached network")
	}
	result, err := client.Datasets.Create(context.Background(), input, CallOptions{IdempotencyKey: "same-request"})
	if err != nil || result.Data.Id != "saved" || calls != 1 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
	}
}

func TestDeniedAndRedirectNeverRetry(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		if string(body) != "{}" {
			t.Errorf("empty input sent %s instead of object", body)
		}
		if calls == 1 {
			w.Header().Set("Location", "/elsewhere")
			w.WriteHeader(302)
			return
		}
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error":{"error":{"code":"cave_scope_forbidden","message":"Scope denied."}}}`))
	}))
	defer server.Close()
	client, err := New(Options{ControlURL: server.URL, AccessToken: "secret", ProjectID: "11111111-1111-4111-8111-111111111111"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Prompts.List(context.Background(), nil, CallOptions{}); err == nil || calls != 1 {
		t.Fatal("redirect was followed")
	}
	_, err = client.Prompts.List(context.Background(), nil, CallOptions{})
	var denied *Error
	if !errors.As(err, &denied) || denied.Code != "cave_scope_forbidden" || denied.Status != 403 || calls != 2 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestOptionalObjectsAreOmitted(t *testing.T) {
	for _, test := range []struct {
		input  any
		absent string
	}{
		{EvalsRunInput{WorkbenchId: "workbench"}, "scope"},
		{ScenariosCreateInput{}, "expected_failure"},
	} {
		raw, err := json.Marshal(test.input)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if value, ok := fields[test.absent]; ok {
			t.Fatalf("optional %s encoded as %s", test.absent, value)
		}
	}
}
