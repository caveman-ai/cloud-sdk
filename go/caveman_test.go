package cavemancloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewCavemanRequiresAPIKey(t *testing.T) {
	t.Setenv("CAVEMAN_API_KEY", "")
	t.Setenv("CAVE_TOKEN", "")
	_, err := NewCaveman(CavemanOptions{})
	if err == nil {
		t.Fatalf("expected error when APIKey is missing")
	}
}

func TestCavemanUnifiedClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/models":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "anthropic/claude-sonnet-4-6"}}})
		case r.URL.Path == "/api/v1/credits":
			_ = json.NewEncoder(w).Encode(map[string]any{"balance_usd": 50.0})
		case r.URL.Path == "/api/v1/code/drives":
			_ = json.NewEncoder(w).Encode(map[string]any{"drives": []map[string]any{{"id": "drv_1", "name": "knowledge"}}})
		case r.URL.Path == "/api/v1/code/connectors":
			_ = json.NewEncoder(w).Encode(map[string]any{"connectors": []map[string]any{{"name": "github"}}})
		case r.URL.Path == "/api/v1/code/secrets" && r.Method == http.MethodPut:
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "STRIPE_KEY", "scope": "org"})
		case r.URL.Path == "/api/v1/code/secrets" && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"secrets": []map[string]any{{"name": "STRIPE_KEY"}}})
		case r.URL.Path == "/api/v1/code/rooms":
			_ = json.NewEncoder(w).Encode(map[string]any{"rooms": []map[string]any{{"id": "rm_1", "slug": "ops"}}})
		case r.URL.Path == "/api/v1/code/apps":
			_ = json.NewEncoder(w).Encode(map[string]any{"apps": []map[string]any{{"id": "app_1", "slug": "dash"}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	cv, err := NewCaveman(CavemanOptions{
		APIKey:     "cave_live_test",
		BaseURL:    srv.URL,
		ControlURL: srv.URL,
	})
	if err != nil {
		t.Fatalf("NewCaveman failed: %v", err)
	}
	ctx := context.Background()

	models, err := cv.ListModels(ctx)
	if err != nil || len(models) != 1 || models[0]["id"] != "anthropic/claude-sonnet-4-6" {
		t.Fatalf("ListModels unexpected: %v, err=%v", models, err)
	}
	credits, err := cv.Credits.Get(ctx)
	if err != nil || credits["balance_usd"] != 50.0 {
		t.Fatalf("Credits.Get unexpected: %v, err=%v", credits, err)
	}
	drives, err := cv.Drives.List(ctx)
	if err != nil || len(drives) != 1 || drives[0].Name != "knowledge" {
		t.Fatalf("Drives.List unexpected: %v, err=%v", drives, err)
	}
	connectors, err := cv.Connectors.List(ctx)
	if err != nil || len(connectors) != 1 || connectors[0]["name"] != "github" {
		t.Fatalf("Connectors.List unexpected: %v, err=%v", connectors, err)
	}
	setRes, err := cv.Secrets.Set(ctx, map[string]any{"name": "STRIPE_KEY", "value": "sk_test"})
	if err != nil || setRes["name"] != "STRIPE_KEY" {
		t.Fatalf("Secrets.Set unexpected: %v, err=%v", setRes, err)
	}
	secrets, err := cv.Secrets.List(ctx)
	if err != nil || len(secrets) != 1 || secrets[0]["name"] != "STRIPE_KEY" {
		t.Fatalf("Secrets.List unexpected: %v, err=%v", secrets, err)
	}
	rooms, err := cv.Rooms.List(ctx)
	if err != nil || len(rooms) != 1 || rooms[0].Slug != "ops" {
		t.Fatalf("Rooms.List unexpected: %v, err=%v", rooms, err)
	}
	apps, err := cv.Apps.List(ctx)
	if err != nil || len(apps) != 1 || apps[0].Slug != "dash" {
		t.Fatalf("Apps.List unexpected: %v, err=%v", apps, err)
	}
}
