package cavemancloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GatewayOptions address the Caveman gateway with a project key, the same
// base URL and key the TypeScript and Python Cave clients use.
type GatewayOptions struct {
	BaseURL   string // gateway base URL
	APIKey    string // project key, sent as Authorization: Bearer
	Agent     string // x-cave-agent
	Workflow  string // x-cave-workflow; default "unlabeled-workflow"
	Retention string // x-cave-retention: "metadata" (default), "zdr" or "configured"
	User      string // optional x-cave-user-hash
	Timeout   time.Duration
	Transport http.RoundTripper
}

// Gateway calls Caveman's models on the gateway: Route picks a model, Trim
// compresses one payload against a query (trim-1), Compact compacts a whole
// message history to a token budget (compact-1). Every call is an explicit
// model call: a non-2xx answer returns an *Error carrying Status, the cave_*
// Code, Message and RequestID. Nothing is retried and redirects are refused.
type Gateway struct {
	options GatewayOptions
	http    *http.Client
}

// RouteResult is the router's decision. Raw holds every field the gateway
// sent, including ones this struct does not name (decision_id, request_id, ...).
type RouteResult struct {
	Model         string         `json:"model"`
	Effort        string         `json:"effort"` // may be empty
	Reason        string         `json:"reason"`
	RouterVersion string         `json:"router_version"`
	Raw           map[string]any `json:"-"`
}

// TrimRequest asks trim-1 to cut what Query does not need from Input.
type TrimRequest struct {
	Input string `json:"input"`
	Query string `json:"query"`           // must be non-blank
	Level string `json:"level,omitempty"` // "conservative", "balanced" (gateway default) or "aggressive"
}

// TrimResult is trim-1's compression of one payload. RecoveryHandle is empty
// when nothing was cut or the request ran under metadata/zdr retention.
type TrimResult struct {
	Output         string `json:"output"`
	TokensBefore   int    `json:"tokens_before"`
	TokensAfter    int    `json:"tokens_after"`
	RecoveryHandle string `json:"recovery_handle,omitempty"`
	Model          string `json:"model"`
}

// CompactRequest asks compact-1 to fit a whole history into BudgetTokens.
// Messages are OpenAI chat-completions or Anthropic Messages-API messages,
// sent untouched. BudgetTokens excludes the leading system messages.
type CompactRequest struct {
	Messages     []any `json:"messages"`
	BudgetTokens int   `json:"budget_tokens"` // must be positive
}

// CompactResult is compact-1's compaction. Messages keep the input's shape,
// byte-for-byte as the gateway sent them; token counts exclude the leading
// system messages.
type CompactResult struct {
	Messages        []json.RawMessage `json:"messages"`
	TokensBefore    int               `json:"tokens_before"`
	TokensAfter     int               `json:"tokens_after"`
	RecoveryHandles []string          `json:"recovery_handles,omitempty"`
	Model           string            `json:"model"`
}

// NewGateway validates options; Timeout defaults to 300s.
func NewGateway(options GatewayOptions) (*Gateway, error) {
	base, err := url.Parse(options.BaseURL)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, &Error{Code: "cave_endpoint_invalid", Message: "BaseURL must be an absolute http(s) URL without credentials, query, or fragment."}
	}
	if strings.TrimSpace(options.APIKey) == "" || strings.TrimSpace(options.Agent) == "" {
		return nil, &Error{Code: "cave_auth_required", Message: "APIKey and Agent are required."}
	}
	options.BaseURL = strings.TrimRight(options.BaseURL, "/")
	if options.Workflow == "" {
		options.Workflow = "unlabeled-workflow"
	}
	if options.Retention == "" {
		options.Retention = "metadata"
	}
	if options.Timeout == 0 {
		options.Timeout = 300 * time.Second
	}
	return &Gateway{options: options, http: &http.Client{Transport: options.Transport, Timeout: options.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return &Error{Code: "cave_redirect_denied", Message: "Gateway redirects are not followed."}
	}}}, nil
}

// Route asks the router which model, and effort, should take a task
// (POST /v1/route, key scope router:write). The request goes out as given: set
// one of "text", "messages" or "signals", and optionally "models".
func (g *Gateway) Route(ctx context.Context, request map[string]any) (result RouteResult, err error) {
	err = g.call(ctx, "/v1/route", request, &result, &result.Raw)
	return result, err
}

// Trim compresses ONE payload against a query with trim-1 (POST /v1/trim, key
// scope sdk:write). To fit a whole history into a budget, use Compact.
func (g *Gateway) Trim(ctx context.Context, request TrimRequest) (result TrimResult, err error) {
	if strings.TrimSpace(request.Query) == "" {
		return result, &Error{Code: "cave_request_invalid", Message: "Query must be non-blank."}
	}
	err = g.call(ctx, "/v1/trim", request, &result)
	return result, err
}

// Compact compacts a WHOLE message history to BudgetTokens with compact-1
// (POST /v1/compact, key scope sdk:write). To compress one payload, use Trim.
func (g *Gateway) Compact(ctx context.Context, request CompactRequest) (result CompactResult, err error) {
	if request.BudgetTokens < 1 {
		return result, &Error{Code: "cave_request_invalid", Message: "BudgetTokens must be a positive integer."}
	}
	err = g.call(ctx, "/v1/compact", request, &result)
	return result, err
}

func (g *Gateway) call(ctx context.Context, path string, body any, results ...any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, g.options.BaseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+g.options.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Cave-Agent", g.options.Agent)
	request.Header.Set("X-Cave-Workflow", g.options.Workflow)
	request.Header.Set("X-Cave-Retention", g.options.Retention)
	if g.options.User != "" {
		request.Header.Set("X-Cave-User-Hash", g.options.User)
	}
	response, err := g.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil {
		return err
	}
	if len(raw) > responseLimit {
		return &Error{Code: "cave_result_too_large", Message: "Response exceeds 16 MiB.", Status: response.StatusCode}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var envelope struct {
			Error struct {
				Code      string `json:"code"`
				Message   string `json:"message"`
				RequestID string `json:"request_id"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &envelope)
		failure := &Error{Code: envelope.Error.Code, Message: envelope.Error.Message, Status: response.StatusCode, RequestID: envelope.Error.RequestID}
		if failure.Code == "" {
			failure.Code = "cave_request_failed"
		}
		if failure.Message == "" {
			failure.Message = strings.TrimSpace(string(raw))
		}
		if failure.Message == "" {
			failure.Message = fmt.Sprintf("Gateway request failed (%d).", response.StatusCode)
		}
		if failure.RequestID == "" {
			failure.RequestID = response.Header.Get("X-Cave-Request-Id")
		}
		return failure
	}
	for _, result := range results {
		if json.Unmarshal(raw, result) != nil {
			return &Error{Code: "cave_invalid_response", Message: "Gateway returned an invalid response.", Status: response.StatusCode}
		}
	}
	return nil
}
