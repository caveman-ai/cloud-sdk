//go:build windows

package drivemount

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	windowsDriveLetterRe = regexp.MustCompile(`^[A-Za-z]:$`)

	modMpr                  = windows.NewLazySystemDLL("mpr.dll")
	procWNetAddConnection2W = modMpr.NewProc("WNetAddConnection2W")
	procWNetCancelConn2W    = modMpr.NewProc("WNetCancelConnection2W")
)

const (
	resourcetypeDisk   = 0x00000001
	connectUpdateNone  = 0x00000000
	errWinAccessDenied = 5
	errWinBadNetName   = 67
	errWinNotAuth      = 1244
)

type netResourceW struct {
	Scope       uint32
	Type        uint32
	DisplayType uint32
	Usage       uint32
	LocalName   *uint16
	RemoteName  *uint16
	Comment     *uint16
	Provider    *uint16
}

// MountOS mounts the loopback WebDAV server on Windows by calling Win32
// WNetAddConnection2W (mpr.dll) directly in-process — zero net.exe spawn, zero
// argv credential exposure, and zero third-party kernel drivers.
func MountOS(_ context.Context, srv *Server, opts MountOptions) (*ActiveMount, error) {
	mp := strings.TrimSpace(opts.MountPoint)
	if mp == "" || mp == "*" {
		chosen, err := firstFreeWindowsDrive()
		if err != nil {
			return nil, err
		}
		mp = chosen
	}
	if !windowsDriveLetterRe.MatchString(mp) {
		return nil, errors.New("on Windows, mountpoint must be a drive letter like Z: or *")
	}
	mp = strings.ToUpper(mp)

	_, port, _ := net.SplitHostPort(srv.Addr())
	// WebClient UNC syntax (`\\127.0.0.1@<port>\DavWWWRoot`) works reliably across
	// Windows 10/11 when the WebClient service is running.
	remoteUNC := fmt.Sprintf(`\\127.0.0.1@%s\DavWWWRoot`, port)
	user, secret := srv.Credentials()

	localPtr, err := windows.UTF16PtrFromString(mp)
	if err != nil {
		return nil, err
	}
	remotePtr, err := windows.UTF16PtrFromString(remoteUNC)
	if err != nil {
		return nil, err
	}
	userPtr, err := windows.UTF16PtrFromString(user)
	if err != nil {
		return nil, err
	}
	passPtr, err := windows.UTF16PtrFromString(secret)
	if err != nil {
		return nil, err
	}

	nr := netResourceW{
		Type:       resourcetypeDisk,
		LocalName:  localPtr,
		RemoteName: remotePtr,
	}
	r1, _, _ := procWNetAddConnection2W.Call(
		uintptr(unsafe.Pointer(&nr)),
		uintptr(unsafe.Pointer(passPtr)),
		uintptr(unsafe.Pointer(userPtr)),
		uintptr(connectUpdateNone),
	)
	if r1 != 0 {
		switch r1 {
		case errWinBadNetName, errWinNotAuth, errWinAccessDenied:
			return nil, fmt.Errorf("Windows WebClient mount failed (win32 error %d): ensure the WebClient service is running and loopback WebDAV BasicAuthLevel allows localhost, or run with --webdav-only", r1)
		default:
			return nil, fmt.Errorf("WNetAddConnection2W failed with win32 error %d", r1)
		}
	}

	return &ActiveMount{
		MountPoint: mp,
		Backend:    "windows-webclient",
		unmountFn: func(context.Context) error {
			targetPtr, err := windows.UTF16PtrFromString(mp)
			if err != nil {
				return err
			}
			r1, _, _ := procWNetCancelConn2W.Call(uintptr(unsafe.Pointer(targetPtr)), 0, 1)
			if r1 != 0 {
				return fmt.Errorf("WNetCancelConnection2W failed with win32 error %d", r1)
			}
			return nil
		},
	}, nil
}

func firstFreeWindowsDrive() (string, error) {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return "", err
	}
	for letter := 'Z'; letter >= 'D'; letter-- {
		bit := uint32(1) << uint(letter-'A')
		if mask&bit == 0 {
			return fmt.Sprintf("%c:", letter), nil
		}
	}
	return "", errors.New("no free Windows drive letters available")
}
