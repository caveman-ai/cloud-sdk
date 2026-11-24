//go:build darwin

package drivemount

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

// MountOS mounts the loopback WebDAV server on macOS using Apple's built-in
// mount_webdav (zero kernel extensions, zero macFUSE, zero root privileges).
// It mounts with nodev,nosuid,noexec (and rdonly when ReadWrite is false),
// scrubs Caveman tokens from subprocess environments, and falls back to forced
// unmount on shutdown if a Finder window or shell holds the mount open.
func MountOS(ctx context.Context, srv *Server, opts MountOptions) (*ActiveMount, error) {
	mp, created, err := preparePosixMountPoint(opts.MountPoint)
	if err != nil {
		return nil, err
	}
	cleanupDir := func() {
		if created {
			_ = os.Remove(mp)
		}
	}

	user, secret := srv.Credentials()
	mountOpts := []string{"nodev", "nosuid", "noexec"}
	if !opts.ReadWrite {
		mountOpts = append(mountOpts, "rdonly")
	}

	u := &url.URL{
		Scheme: "http",
		User:   url.UserPassword(user, secret),
		Host:   srv.Addr(),
		Path:   "/",
	}

	args := []string{
		"-S",
		"-v", SanitizeVolumeName(opts.VolumeName),
		"-o", strings.Join(mountOpts, ","),
		u.String(),
		mp,
	}
	cmd := exec.CommandContext(ctx, "/sbin/mount_webdav", args...)
	cmd.Env = scrubbedEnv()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		cleanupDir()
		msg := SanitizeTerminalText(strings.ReplaceAll(stderr.String(), secret, "[redacted]"))
		return nil, fmt.Errorf("mount_webdav failed: %w (%s)", err, msg)
	}

	return &ActiveMount{
		MountPoint: mp,
		Backend:    "macos-webdav",
		unmountFn: func(uctx context.Context) error {
			unmountCmd := func(bin string, a ...string) error {
				c := exec.CommandContext(uctx, bin, a...)
				c.Env = scrubbedEnv()
				return c.Run()
			}
			if err := unmountCmd("/usr/sbin/diskutil", "unmount", mp); err != nil {
				if err := unmountCmd("/sbin/umount", mp); err != nil {
					if err := unmountCmd("/usr/sbin/diskutil", "unmount", "force", mp); err != nil {
						if err := unmountCmd("/sbin/umount", "-f", mp); err != nil {
							return fmt.Errorf("unmount %s failed: %w", mp, err)
						}
					}
				}
			}
			cleanupDir()
			return nil
		},
	}, nil
}
