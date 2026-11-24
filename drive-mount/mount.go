package drivemount

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// MountOptions controls how the local OS attaches to the loopback WebDAV server.
type MountOptions struct {
	// MountPoint is the local directory (macOS/Linux) or drive letter like "Z:" (Windows).
	MountPoint string
	// VolumeName is the human-readable volume label (macOS Finder / Linux).
	VolumeName string
	// ReadWrite mounts writable when true; read-only by default.
	ReadWrite bool
}

// ActiveMount represents an attached OS filesystem mount that must be Unmounted
// cleanly on exit.
type ActiveMount struct {
	MountPoint string
	Backend    string
	unmountFn  func(context.Context) error
}

// Unmount detaches the OS mount point. Safe to call more than once.
func (m *ActiveMount) Unmount(ctx context.Context) error {
	if m == nil || m.unmountFn == nil {
		return nil
	}
	fn := m.unmountFn
	m.unmountFn = nil
	return fn(ctx)
}

var safeVolumeRe = regexp.MustCompile(`[^a-zA-Z0-9._ -]+`)

// SanitizeVolumeName cleans a volume label so it contains no path separators,
// control chars, or trailing dots/spaces even after length clamping.
func SanitizeVolumeName(name string) string {
	s := strings.TrimSpace(safeVolumeRe.ReplaceAllString(name, "-"))
	s = strings.Trim(s, "-. ")
	if len(s) > 48 {
		s = strings.Trim(s[:48], "-. ")
	}
	if s == "" {
		return "Caveman Drive"
	}
	return s
}

// scrubbedEnv returns os.Environ() with Caveman credential variables removed so
// OS mount helpers (mount_webdav, diskutil, umount, gio, mount.davfs) never
// inherit CAVE_TOKEN or CAVEMAN_DRIVE_TOKEN.
func scrubbedEnv() []string {
	raw := os.Environ()
	out := make([]string, 0, len(raw))
	for _, kv := range raw {
		if strings.HasPrefix(kv, "CAVE_TOKEN=") || strings.HasPrefix(kv, "CAVEMAN_DRIVE_TOKEN=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// preparePosixMountPoint validates or creates a safe empty 0700 directory for
// mounting on macOS/Linux. It refuses symlinks (both at the leaf AND along any
// ancestor component that does not match its canonical path), non-directories,
// and non-empty directories so an accidental mount never masks local files.
func preparePosixMountPoint(raw string) (string, bool, error) {
	if strings.TrimSpace(raw) == "" {
		return "", false, errors.New("mountpoint is required")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", false, err
	}
	// Walk up to the deepest existing ancestor and ensure no symlink sits on the path.
	if err := rejectAncestorSymlinks(abs); err != nil {
		return "", false, err
	}
	st, err := os.Lstat(abs)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(abs, 0o700); err != nil {
			return "", false, fmt.Errorf("create mountpoint %s: %w", abs, err)
		}
		if err := os.Chmod(abs, 0o700); err != nil {
			_ = os.Remove(abs)
			return "", false, err
		}
		return abs, true, nil
	}
	if err != nil {
		return "", false, err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return "", false, fmt.Errorf("mountpoint %s is a symlink; refusing to mount through symlinks", abs)
	}
	if !st.IsDir() {
		return "", false, fmt.Errorf("mountpoint %s is not a directory", abs)
	}
	if st.Mode().Perm()&0o002 != 0 {
		return "", false, fmt.Errorf("mountpoint %s is world-writable; refusing insecure mountpoint", abs)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return "", false, err
	}
	if len(entries) > 0 {
		return "", false, fmt.Errorf("mountpoint %s is not empty; choose an empty directory", abs)
	}
	return abs, false, nil
}

func rejectAncestorSymlinks(abs string) error {
	clean := filepath.Clean(abs)
	// Walk from the target upward checking every existing directory component.
	cur := clean
	for {
		st, err := os.Lstat(cur)
		if err == nil {
			if st.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("mountpoint path %s traverses symlink %s; refusing to mount", abs, cur)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return nil
		}
		cur = parent
	}
}
