//go:build !darwin && !windows && !linux

package drivemount

import (
	"context"
	"errors"
)

// MountOS returns an explicit unsupported error on platforms without a native
// mount orchestrator; callers can still use --webdav-only.
func MountOS(context.Context, *Server, MountOptions) (*ActiveMount, error) {
	return nil, errors.New("automatic OS mount is supported on macOS, Windows, and Linux; use --webdav-only on this platform")
}
