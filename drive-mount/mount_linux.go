//go:build linux

package drivemount

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func resolveTrustedBinary(candidates ...string) string {
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// MountOS mounts the loopback WebDAV server on Linux without requiring kernel
// extensions. When running as root with mount.davfs available, it mounts at the
// requested mountpoint with noexec,nosuid,nodev[,ro] and stdin credentials. For
// unprivileged desktop sessions, it falls back cleanly to `gio mount` (GVFS).
func MountOS(ctx context.Context, srv *Server, opts MountOptions) (*ActiveMount, error) {
	user, secret := srv.Credentials()
	davfs := resolveTrustedBinary("/sbin/mount.davfs", "/usr/sbin/mount.davfs")
	umountBin := resolveTrustedBinary("/bin/umount", "/usr/bin/umount")

	if os.Geteuid() == 0 && davfs != "" && umountBin != "" && strings.TrimSpace(opts.MountPoint) != "" {
		mp, created, err := preparePosixMountPoint(opts.MountPoint)
		if err != nil {
			return nil, err
		}
		cleanupDir := func() {
			if created {
				_ = os.Remove(mp)
			}
		}
		mountOpts := []string{"noexec", "nosuid", "nodev"}
		if !opts.ReadWrite {
			mountOpts = append(mountOpts, "ro")
		}
		cmd := exec.CommandContext(ctx, davfs, "-o", strings.Join(mountOpts, ","), srv.URL(), mp)
		cmd.Env = scrubbedEnv()
		cmd.Stdin = strings.NewReader(user + "\n" + secret + "\n")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err == nil {
			return &ActiveMount{
				MountPoint: mp,
				Backend:    "linux-davfs2",
				unmountFn: func(uctx context.Context) error {
					c := exec.CommandContext(uctx, umountBin, mp)
					c.Env = scrubbedEnv()
					err := c.Run()
					cleanupDir()
					return err
				},
			}, nil
		}
		cleanupDir()
	}

	if gio := resolveTrustedBinary("/usr/bin/gio", "/bin/gio"); gio != "" {
		davURL := (&url.URL{
			Scheme: "dav",
			User:   url.User(user),
			Host:   srv.Addr(),
			Path:   "/",
		}).String()
		cmd := exec.CommandContext(ctx, gio, "mount", davURL)
		cmd.Env = scrubbedEnv()
		cmd.Stdin = strings.NewReader(secret + "\n")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			msg := SanitizeTerminalText(strings.ReplaceAll(stderr.String(), secret, "[redacted]"))
			return nil, fmt.Errorf("gio mount failed: %w (%s)", err, msg)
		}
		mp := davURL
		if xdg := strings.TrimSpace(os.Getenv("XDG_RUNTIME_DIR")); xdg != "" {
			if matches, _ := filepath.Glob(filepath.Join(xdg, "gvfs", "dav:host=127.0.0.1*")); len(matches) > 0 {
				mp = matches[0]
			}
		}
		return &ActiveMount{
			MountPoint: mp,
			Backend:    "linux-gvfs",
			unmountFn: func(uctx context.Context) error {
				c := exec.CommandContext(uctx, gio, "mount", "-u", davURL)
				c.Env = scrubbedEnv()
				return c.Run()
			},
		}, nil
	}

	return nil, errors.New("no supported Linux WebDAV mounter found (run as root with davfs2, install gvfs-bin, or use --webdav-only)")
}
