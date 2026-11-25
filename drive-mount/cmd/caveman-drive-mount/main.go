package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	drivemount "github.com/caveman-ai/cloud-sdk/drive-mount"
)

func main() {
	os.Exit(run())
}

func run() int {
	var (
		driveName        = flag.String("drive", "", "Drive name or UUID (omit when using CAVEMAN_DRIVE_TOKEN)")
		subpath          = flag.String("path", "/", "Subfolder inside the drive to mount as root")
		mountPoint       = flag.String("mountpoint", "", "Local directory (macOS/Linux) or drive letter e.g. Z: (Windows)")
		volumeName       = flag.String("volume-name", "", "Display volume name (defaults to drive name)")
		apiURL           = flag.String("api-url", "", "Caveman Cloud API URL (defaults to CAVE_API_URL or https://api.caveman.so)")
		readWrite        = flag.Bool("read-write", false, "Allow writes (default is read-only)")
		includeProtected = flag.Bool("include-protected", false, "Expose protected paths (.git, .envrc, CLAUDE.md, etc.); hidden by default")
		webdavOnly       = flag.Bool("webdav-only", false, "Start only the hardened loopback WebDAV server without invoking the OS mounter")
		tokenStdin       = flag.Bool("token-stdin", false, "Read the Caveman auth or cdrv_ share token from stdin (avoids env/argv exposure)")
		jsonOut          = flag.Bool("json", false, "Emit machine-readable JSON status on stdout")
	)
	flag.Parse()

	token, err := resolveToken(*tokenStdin)
	// Scrub token environment variables immediately so child processes never inherit them.
	_ = os.Unsetenv("CAVEMAN_DRIVE_TOKEN")
	_ = os.Unsetenv("CAVE_TOKEN")
	if err != nil {
		fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		return 2
	}

	resolvedURL := strings.TrimSpace(*apiURL)
	if resolvedURL == "" {
		resolvedURL = strings.TrimSpace(os.Getenv("CAVE_API_URL"))
	}
	if resolvedURL == "" {
		resolvedURL = drivemount.DefaultAPIURL
	}

	client, err := drivemount.NewDriveClient(drivemount.ClientConfig{
		APIURL: resolvedURL,
		Token:  token,
		Drive:  *driveName,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		return 2
	}

	probeCtx, cancelProbe := context.WithTimeout(context.Background(), 15*time.Second)
	shareMeta, err := client.Probe(probeCtx)
	cancelProbe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		return 1
	}

	effectiveRW := *readWrite
	if shareMeta != nil && effectiveRW && !shareMeta.Write {
		fmt.Fprintln(os.Stderr, "caveman-drive-mount: share token is read-only; refusing --read-write")
		return 3
	}

	dfs, err := drivemount.NewDriveFS(client, drivemount.FSOptions{
		Subpath:          *subpath,
		ReadWrite:        effectiveRW,
		IncludeProtected: *includeProtected,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		return 1
	}
	subCtx, cancelSub := context.WithTimeout(context.Background(), 15*time.Second)
	if err := dfs.VerifySubpath(subCtx); err != nil {
		cancelSub()
		_ = dfs.Close()
		fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		return 1
	}
	cancelSub()

	srv, err := drivemount.StartServer(dfs)
	if err != nil {
		_ = dfs.Close()
		fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		return 1
	}

	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	var mounted *drivemount.ActiveMount
	if !*webdavOnly {
		mp := strings.TrimSpace(*mountPoint)
		explicitMP := mp != ""
		if !explicitMP {
			mp, err = defaultMountPoint(*driveName)
			if err != nil {
				_ = srv.Close(context.Background())
				fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
				return 1
			}
		}
		vol := strings.TrimSpace(*volumeName)
		if vol == "" {
			if *driveName != "" {
				vol = "Caveman " + *driveName
			} else {
				vol = "Caveman Drive"
			}
		}
		mountCtx, cancelMount := context.WithTimeout(ctx, 20*time.Second)
		mounted, err = drivemount.MountOS(mountCtx, srv, drivemount.MountOptions{
			MountPoint:         mp,
			ExplicitMountPoint: explicitMP,
			VolumeName:         vol,
			ReadWrite:          effectiveRW,
		})
		cancelMount()
		if err != nil {
			_ = srv.Close(context.Background())
			fmt.Fprintf(os.Stderr, "caveman-drive-mount: %s\n", drivemount.SanitizeTerminalText(err.Error()))
			return 1
		}
	}

	mode := "read-only"
	if effectiveRW {
		mode = "read-write"
	}
	if *jsonOut {
		payload := map[string]any{
			"status":           "mounted",
			"mode":             mode,
			"protected_hidden": !*includeProtected,
			"loopback_url":     srv.URL(),
			"webdav_only":      *webdavOnly,
			"os":               runtime.GOOS,
		}
		if mounted != nil {
			payload["mountpoint"] = mounted.MountPoint
			payload["backend"] = mounted.Backend
		} else if *webdavOnly {
			user, secret := srv.Credentials()
			payload["username"] = user
			payload["secret"] = secret
		}
		_ = json.NewEncoder(os.Stdout).Encode(payload)
	} else if mounted != nil {
		fmt.Printf("mounted  %s (%s, %s, protected paths %s)\n", mounted.MountPoint, mounted.Backend, mode, protectedLabel(*includeProtected))
		fmt.Println("Press Ctrl+C to unmount cleanly.")
	} else {
		user, secret := srv.Credentials()
		fmt.Printf("webdav   %s (%s, protected paths %s)\n", srv.URL(), mode, protectedLabel(*includeProtected))
		fmt.Printf("user     %s\n", user)
		fmt.Printf("secret   %s\n", secret)
		fmt.Println("Press Ctrl+C to stop.")
	}

	<-ctx.Done()

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if mounted != nil {
		if err := mounted.Unmount(shutdownCtx); err != nil {
			fmt.Fprintf(os.Stderr, "caveman-drive-mount: unmount warning: %s\n", drivemount.SanitizeTerminalText(err.Error()))
		}
	}
	_ = srv.Close(shutdownCtx)
	return 0
}

func resolveToken(fromStdin bool) (string, error) {
	if fromStdin {
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
		if err != nil {
			return "", fmt.Errorf("read token from stdin: %w", err)
		}
		if len(raw) > 4096 {
			return "", fmt.Errorf("token on stdin exceeds 4096 bytes")
		}
		tok := strings.TrimSpace(string(raw))
		if tok == "" {
			return "", fmt.Errorf("no token provided on stdin")
		}
		return tok, nil
	}
	if tok := strings.TrimSpace(os.Getenv("CAVEMAN_DRIVE_TOKEN")); tok != "" {
		return tok, nil
	}
	if tok := strings.TrimSpace(os.Getenv("CAVE_TOKEN")); tok != "" {
		return tok, nil
	}
	return "", fmt.Errorf("set CAVEMAN_DRIVE_TOKEN, CAVE_TOKEN, or pass --token-stdin")
}

func defaultMountPoint(driveName string) (string, error) {
	if runtime.GOOS == "windows" {
		return "*", nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	slug := drivemount.SanitizeVolumeName(driveName)
	if slug == "Caveman Drive" {
		slug = "shared"
	}
	return filepath.Join(home, "CavemanDrives", slug), nil
}

func protectedLabel(include bool) string {
	if include {
		return "exposed"
	}
	return "hidden"
}
