package cavemancloud

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	DefaultGatewayURL = "https://gateway.caveman.so"
	DefaultControlURL = "https://api.caveman.so"
)

// CavemanOptions configures the unified Caveman Cloud client.
type CavemanOptions struct {
	APIKey     string
	BaseURL    string
	ControlURL string
	RelayURL   string
	ProjectID  string
	Agent      string
	Timeout    time.Duration
	Retries    int
	RetryDelay time.Duration
	Transport  http.RoundTripper
}

// Caveman is the unified Caveman Cloud SDK facade across Inference, Managed
// Agents, Sessions, Sandboxes, Drives, Connectors, Secrets, Rooms, Apps,
// Credits, and raw Cloud operations.
type Caveman struct {
	Inference  *Gateway
	Agents     *Agents
	Sandboxes  *Sandboxes
	Pools      *ComputerPools
	Drives     *DrivesClient
	Connectors *ConnectorsClient
	Secrets    *SecretsClient
	Rooms      *Rooms
	Apps       *Apps
	Credits    *CreditsClient
	Cloud      *Client

	gatewayTx *platformTransport
}

// NewCaveman creates a unified Caveman Cloud client. If APIKey is empty, it
// reads CAVEMAN_API_KEY or CAVE_TOKEN from the environment.
func NewCaveman(opts CavemanOptions) (*Caveman, error) {
	apiKey := strings.TrimSpace(opts.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("CAVEMAN_API_KEY"))
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("CAVE_TOKEN"))
	}
	if apiKey == "" {
		return nil, &Error{Code: "cave_auth_required", Message: "APIKey is required (pass CavemanOptions.APIKey or set CAVEMAN_API_KEY)."}
	}
	baseURL := strings.TrimSpace(opts.BaseURL)
	if baseURL == "" {
		if env := strings.TrimSpace(os.Getenv("CAVEMAN_GATEWAY_URL")); env != "" {
			baseURL = env
		} else {
			baseURL = DefaultGatewayURL
		}
	}
	controlURL := strings.TrimSpace(opts.ControlURL)
	if controlURL == "" {
		if env := strings.TrimSpace(os.Getenv("CAVEMAN_API_URL")); env != "" {
			controlURL = env
		} else {
			controlURL = DefaultControlURL
		}
	}
	agent := strings.TrimSpace(opts.Agent)
	if agent == "" {
		agent = "default"
	}

	pOpts := PlatformOptions{
		ControlURL: controlURL,
		APIKey:     apiKey,
		Timeout:    opts.Timeout,
		Retries:    opts.Retries,
		RetryDelay: opts.RetryDelay,
		Transport:  opts.Transport,
	}
	tx, err := newPlatformTransport(pOpts)
	if err != nil {
		return nil, err
	}
	gatewayTx, err := newPlatformTransport(PlatformOptions{
		ControlURL: baseURL,
		APIKey:     apiKey,
		Timeout:    opts.Timeout,
		Retries:    opts.Retries,
		RetryDelay: opts.RetryDelay,
		Transport:  opts.Transport,
	})
	if err != nil {
		return nil, err
	}
	gw, err := NewGateway(GatewayOptions{
		BaseURL:   baseURL,
		APIKey:    apiKey,
		Agent:     agent,
		Timeout:   opts.Timeout,
		Transport: opts.Transport,
	})
	if err != nil {
		return nil, err
	}
	agentsClient, err := NewAgents(AgentsOptions{
		ControlURL: controlURL,
		APIKey:     apiKey,
		Timeout:    opts.Timeout,
		Transport:  opts.Transport,
	})
	if err != nil {
		return nil, err
	}
	sandboxesClient, err := NewSandboxes(SandboxesOptions{
		ControlURL: controlURL,
		APIKey:     apiKey,
		RelayURL:   opts.RelayURL,
		Timeout:    opts.Timeout,
		Retries:    opts.Retries,
		Transport:  opts.Transport,
	})
	if err != nil {
		return nil, err
	}
	poolsClient, err := NewComputerPools(pOpts)
	if err != nil {
		return nil, err
	}
	roomsClient, err := NewRooms(pOpts)
	if err != nil {
		return nil, err
	}
	appsClient, err := NewApps(pOpts)
	if err != nil {
		return nil, err
	}
	cloudClient, err := New(Options{
		ControlURL:  controlURL,
		AccessToken: apiKey,
		ProjectID:   opts.ProjectID,
		Timeout:     opts.Timeout,
		Transport:   opts.Transport,
	})
	if err != nil {
		return nil, err
	}

	return &Caveman{
		Inference:  gw,
		Agents:     agentsClient,
		Sandboxes:  sandboxesClient,
		Pools:      poolsClient,
		Drives:     &DrivesClient{raw: agentsClient},
		Connectors: &ConnectorsClient{tx: tx},
		Secrets:    &SecretsClient{tx: tx},
		Rooms:      roomsClient,
		Apps:       appsClient,
		Credits:    &CreditsClient{tx: tx},
		Cloud:      cloudClient,
		gatewayTx:  gatewayTx,
	}, nil
}

// ListModels returns the unified inference gateway catalog (GET /v1/models).
func (c *Caveman) ListModels(ctx context.Context) ([]map[string]any, error) {
	var out struct {
		Data []map[string]any `json:"data"`
	}
	if err := c.gatewayTx.do(ctx, http.MethodGet, "/v1/models", nil, "", &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

// DrivesClient provides first-class access to Caveman Drives.
type DrivesClient struct{ raw *Agents }

func (d *DrivesClient) Create(ctx context.Context, input AgentsCreateDriveInput) (CodeDriveCreated, error) {
	return d.raw.CreateDrive(ctx, input)
}
func (d *DrivesClient) List(ctx context.Context) ([]CodeDrive, error) {
	out, err := d.raw.ListDrives(ctx)
	return out.Drives, err
}
func (d *DrivesClient) Get(ctx context.Context, driveID string) (CodeDrive, error) {
	return d.raw.GetDrive(ctx, driveID)
}
func (d *DrivesClient) Usage(ctx context.Context) (CodeDriveUsage, error) {
	return d.raw.GetDriveUsage(ctx)
}
func (d *DrivesClient) Grep(ctx context.Context, driveID string, input AgentsGrepDriveInput) (CodeDriveGrepResult, error) {
	return d.raw.GrepDrive(ctx, driveID, input)
}
func (d *DrivesClient) ReadText(ctx context.Context, driveID string, input AgentsReadDriveTextInput) (CodeDriveText, error) {
	return d.raw.ReadDriveText(ctx, driveID, input)
}
func (d *DrivesClient) WriteText(ctx context.Context, driveID string, input AgentsWriteDriveTextInput) (CodeDriveWriteResult, error) {
	return d.raw.WriteDriveText(ctx, driveID, input)
}
func (d *DrivesClient) Diff(ctx context.Context, driveID string, query AgentsDiffDriveQuery) (CodeDriveDiff, error) {
	return d.raw.DiffDrive(ctx, driveID, query)
}
func (d *DrivesClient) ListChangesets(ctx context.Context, driveID string, query AgentsListDriveChangesetsQuery) ([]CodeDriveChangeset, error) {
	out, err := d.raw.ListDriveChangesets(ctx, driveID, query)
	return out.Changesets, err
}
func (d *DrivesClient) ApproveChangeset(ctx context.Context, driveID, changesetID string, input AgentsApproveDriveChangesetInput) (CodeDriveChangesetDecided, error) {
	return d.raw.ApproveDriveChangeset(ctx, driveID, changesetID, input)
}
func (d *DrivesClient) RejectChangeset(ctx context.Context, driveID, changesetID string) (CodeDriveChangesetDecided, error) {
	return d.raw.RejectDriveChangeset(ctx, driveID, changesetID)
}
func (d *DrivesClient) UndoSession(ctx context.Context, driveID, sessionID string) (CodeDriveUndone, error) {
	return d.raw.UndoDriveSession(ctx, driveID, AgentsUndoDriveSessionInput{SessionId: sessionID})
}

// ConnectorsClient manages team-authenticated SaaS and MCP connectors.
type ConnectorsClient struct{ tx *platformTransport }

func (c *ConnectorsClient) List(ctx context.Context) ([]map[string]any, error) {
	var out struct {
		Connectors []map[string]any `json:"connectors"`
	}
	if err := c.tx.do(ctx, http.MethodGet, "/api/v1/code/connectors", nil, "", &out); err != nil {
		return nil, err
	}
	return out.Connectors, nil
}

func (c *ConnectorsClient) Get(ctx context.Context, connector string) (map[string]any, error) {
	var out map[string]any
	if err := c.tx.do(ctx, http.MethodGet, "/api/v1/code/connectors/"+url.PathEscape(connector), nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SecretsClient manages write-only organization, repository, and runtime secrets.
type SecretsClient struct{ tx *platformTransport }

func (s *SecretsClient) List(ctx context.Context) ([]map[string]any, error) {
	var out struct {
		Secrets []map[string]any `json:"secrets"`
	}
	if err := s.tx.do(ctx, http.MethodGet, "/api/v1/code/secrets", nil, "", &out); err != nil {
		return nil, err
	}
	return out.Secrets, nil
}

func (s *SecretsClient) Set(ctx context.Context, input map[string]any) (map[string]any, error) {
	var out map[string]any
	if err := s.tx.do(ctx, http.MethodPut, "/api/v1/code/secrets", input, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *SecretsClient) Delete(ctx context.Context, name string) error {
	return s.tx.do(ctx, http.MethodDelete, "/api/v1/code/secrets/"+url.PathEscape(name), nil, "", nil)
}

// CreditsClient reads the organization's unified Credits balance.
type CreditsClient struct{ tx *platformTransport }

func (c *CreditsClient) Get(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.tx.do(ctx, http.MethodGet, "/api/v1/credits", nil, "", &out); err != nil {
		return nil, err
	}
	return out, nil
}
