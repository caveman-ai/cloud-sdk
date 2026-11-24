package cavemancloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentsTransport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cave_live_x" {
			t.Errorf("missing key on %s", r.URL)
		}
		switch r.Method + " " + r.URL.RequestURI() {
		case "POST /api/v1/code/sessions":
			var in AgentsStartSessionInput
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.RequestId != "r1" || in.Task != "Fix it" {
				t.Errorf("start body %+v %v", in, err)
			}
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id":"s1","workspace_id":"w1","origin":"api","status":"starting","usage":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":0,"cost_usd":0.5},"pull_requests":[],"created_at":"2026-10-21T00:00:00Z","updated_at":"2026-10-21T00:00:00Z","metadata":{}}`)
		case "GET /api/v1/code/sessions/s%201/events?after=2":
			fmt.Fprint(w, `{"events":[{"seq":3,"type":"agent.message","created_at":"2026-10-21T00:00:00Z","data":{"text":"hi"}}]}`)
		case "GET /api/v1/code/sessions/s1/events/stream?after=0":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, ": caveman session events\n\nid: 1\nevent: session.status\ndata: {\"status\":\"running\"}\n\nid: 2\nevent: agent.message\ndata: {\"text\":\"Looking.\"}\n\n")
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"error":{"code":"cave_not_found","message":"Session not found."}}`)
		}
	}))
	defer server.Close()
	if _, err := NewAgents(AgentsOptions{ControlURL: "http://control.example", APIKey: "cave_live_x"}); err == nil {
		t.Fatal("plain HTTP to a non-loopback host must be refused")
	}
	agents, err := NewAgents(AgentsOptions{ControlURL: server.URL, APIKey: "cave_live_x"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	repo := "acme/api"
	session, err := agents.StartSession(ctx, AgentsStartSessionInput{RequestId: "r1", Repo: &repo, Task: "Fix it"})
	if err != nil || session.Id != "s1" || session.Usage.CostUsd != 0.5 {
		t.Fatalf("start %+v %v", session, err)
	}
	after, limit := int64(2), (*int64)(nil)
	events, err := agents.ListEvents(ctx, "s 1", AgentsListEventsQuery{After: &after, Limit: limit})
	if err != nil || len(events.Events) != 1 || events.Events[0].Seq != 3 {
		t.Fatalf("events %+v %v", events, err)
	}
	var streamed []CodeStreamEvent
	if err := agents.StreamEvents(ctx, "s1", 0, func(e CodeStreamEvent) error { streamed = append(streamed, e); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(streamed) != 2 || streamed[0].Seq != 1 || streamed[1].Type != "agent.message" || string(streamed[1].Data) != `{"text":"Looking."}` {
		t.Fatalf("stream %+v", streamed)
	}
	var refusal *Error
	if _, err := agents.GetSession(ctx, "gone"); !errors.As(err, &refusal) || refusal.Code != "cave_not_found" || refusal.Status != 404 {
		t.Fatalf("refusal %v", err)
	}
}

func TestAgentsFilesAndMemory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.RequestURI() {
		case "POST /api/v1/code/files":
			file, header, err := r.FormFile("file")
			if err != nil || header.Filename != "notes.txt" || header.Header.Get("Content-Type") != "text/plain" {
				t.Errorf("upload part %+v %v", header, err)
				return
			}
			body, _ := io.ReadAll(file)
			if string(body) != "hello" {
				t.Errorf("upload body %q", body)
			}
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id":"f1","name":"notes.txt","media_type":"text/plain","size_bytes":5,"sha256":"x","purpose":"input","created_at":"2026-10-21T00:00:00Z"}`)
		case "GET /api/v1/code/files/f%201/content":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write([]byte{1, 2, 3})
		case "GET /api/v1/code/memory-stores/m1/memories?path=a%2Fb.md":
			fmt.Fprint(w, `{"path":"a/b.md","content":"hi","sha256":"s","size_bytes":2,"updated_at":"2026-10-21T00:00:00Z"}`)
		case "DELETE /api/v1/code/files/f1":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			fmt.Fprint(w, `{"error":{"code":"cave_code_file_too_large","message":"Files are at most 100 MiB."}}`)
		}
	}))
	defer server.Close()
	agents, err := NewAgents(AgentsOptions{ControlURL: server.URL, APIKey: "cave_live_x"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	file, err := agents.UploadFile(ctx, "notes.txt", "text/plain", strings.NewReader("hello"))
	if err != nil || file.Id != "f1" || file.SizeBytes != 5 {
		t.Fatalf("upload %+v %v", file, err)
	}
	var got bytes.Buffer
	if err := agents.DownloadFile(ctx, "f 1", &got); err != nil || !bytes.Equal(got.Bytes(), []byte{1, 2, 3}) {
		t.Fatalf("download %v %v", got.Bytes(), err)
	}
	path := "a/b.md"
	memory, err := agents.GetMemory(ctx, "m1", AgentsGetMemoryQuery{Path: &path})
	if err != nil || memory.Content == nil || *memory.Content != "hi" {
		t.Fatalf("memory %+v %v", memory, err)
	}
	if _, err := agents.DeleteFile(ctx, "f1"); err != nil {
		t.Fatalf("delete %v", err)
	}
	var refusal *Error
	if err := agents.DownloadFile(ctx, "gone", io.Discard); !errors.As(err, &refusal) || refusal.Code != "cave_code_file_too_large" || refusal.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("refusal %v", err)
	}
}
