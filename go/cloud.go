// Package cavemancloud provides typed control-plane resources. It does not
// replace provider SDKs or widen the permissions of the supplied access token.
package cavemancloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Options struct {
	ControlURL  string
	AccessToken string
	ProjectID   string
	Timeout     time.Duration
	Transport   http.RoundTripper
}
type CallOptions struct{ IdempotencyKey string }
type Result[T any] struct {
	SchemaVersion  int    `json:"schema_version"`
	Operation      string `json:"operation"`
	Version        string `json:"version"`
	ContractSHA256 string `json:"contract_sha256"`
	OK             bool   `json:"ok"`
	Status         string `json:"status"`
	Data           T      `json:"data"`
	RequestID      string `json:"request_id,omitempty"`
	ReceiptID      string `json:"receipt_id,omitempty"`
}
type Error struct {
	Code    string
	Message string
	Status  int
	// RequestID is the gateway's request id, set by Gateway calls when the answer carried one.
	RequestID string
	// RetryAfter is the seconds the API asked to wait before asking again (its Retry-After), set
	// by Sandboxes calls when the answer carried one; nil when it named none.
	RetryAfter *int
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type operation struct {
	scope, version, contract string
	transactional            bool
}
type Client struct {
	resources
	endpoint, token, project string
	http                     *http.Client
}

var projectUUID = regexp.MustCompile(`(?i)^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)

const responseLimit = 16 * 1024 * 1024

func New(options Options) (*Client, error) {
	endpoint, err := url.Parse(options.ControlURL)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && (endpoint.Hostname() == "localhost" || endpoint.Hostname() == "127.0.0.1" || endpoint.Hostname() == "::1"))) {
		return nil, &Error{Code: "cave_endpoint_invalid", Message: "Use HTTPS or loopback HTTP without credentials, query, or fragment."}
	}
	if strings.TrimSpace(options.AccessToken) == "" {
		return nil, &Error{Code: "cave_auth_required", Message: "A Cloud access token is required."}
	}
	if options.ProjectID != "" && !projectUUID.MatchString(options.ProjectID) {
		return nil, &Error{Code: "cave_project_required", Message: "ProjectID must be a UUID."}
	}
	if options.Timeout == 0 {
		options.Timeout = 30 * time.Second
	}
	if options.Timeout < 100*time.Millisecond || options.Timeout > 120*time.Second {
		return nil, &Error{Code: "cave_timeout_invalid", Message: "Timeout must be 100ms–120s."}
	}
	c := &Client{endpoint: strings.TrimRight(options.ControlURL, "/"), token: options.AccessToken, project: options.ProjectID, http: &http.Client{Transport: options.Transport, Timeout: options.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return &Error{Code: "cave_redirect_denied", Message: "Cloud redirects are not followed."}
	}}}
	bindResources(c)
	return c, nil
}

func execute[T any](ctx context.Context, c *Client, id string, input any, options CallOptions) (result Result[T], err error) {
	op, ok := operations[id]
	if !ok {
		return result, &Error{Code: "cave_unknown_operation", Message: "Unknown Cloud operation."}
	}
	if op.scope == "project" && c.project == "" {
		return result, &Error{Code: "cave_project_required", Message: "Select a project before calling this resource."}
	}
	if op.transactional && strings.TrimSpace(options.IdempotencyKey) == "" {
		return result, &Error{Code: "cave_idempotency_key_required", Message: "This write requires an idempotency key; reuse it only for identical retries."}
	}
	body, err := json.Marshal(input)
	if err != nil {
		return result, err
	}
	if bytes.Equal(body, []byte("null")) {
		body = []byte("{}")
	}
	if len(body) > responseLimit {
		return result, &Error{Code: "cave_input_invalid", Message: "Input exceeds 16 MiB."}
	}
	scope := ""
	if op.scope == "project" {
		scope = "/projects/" + c.project
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/api/v1"+scope+"/cloud/operations/"+url.PathEscape(id), bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Cave-Operation-Contract", op.contract)
	if options.IdempotencyKey != "" {
		request.Header.Set("Idempotency-Key", options.IdempotencyKey)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil {
		return result, err
	}
	if len(raw) > responseLimit {
		return result, &Error{Code: "cave_result_too_large", Message: "Result exceeds 16 MiB; narrow the query."}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var outer struct {
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(raw, &outer)
		var nested struct {
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(outer.Error, &nested)
		if len(nested.Error) > 0 {
			outer.Error = nested.Error
		}
		var failure struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(outer.Error, &failure)
		if failure.Code == "" {
			failure.Code = "cave_request_failed"
		}
		if failure.Message == "" {
			failure.Message = fmt.Sprintf("Cloud request failed (%d).", response.StatusCode)
		}
		return result, &Error{Code: failure.Code, Message: failure.Message, Status: response.StatusCode}
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil || json.Unmarshal(raw, &result) != nil {
		return result, &Error{Code: "cave_invalid_response", Message: "Cloud returned an invalid envelope.", Status: response.StatusCode}
	}
	if result.SchemaVersion != 1 || result.Operation != id || result.Version != op.version || result.ContractSHA256 != op.contract || !result.OK || (result.Status != "completed" && result.Status != "accepted") || envelope["data"] == nil {
		return result, &Error{Code: "cave_operation_version_conflict", Message: "Cloud returned a mismatched operation result.", Status: response.StatusCode}
	}
	return result, nil
}
