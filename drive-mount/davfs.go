package drivemount

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/webdav"
)

const (
	maxDirCacheEntries   = 512
	maxVirtualDirs       = 256
	maxAppleDoubleItems  = 64
	maxAppleDoubleBytes  = 64 << 10
	maxTotalStagingBytes = 512 << 20
)

// FSOptions configures security and caching behavior for the mounted Caveman Drive.
type FSOptions struct {
	// Subpath scopes the local mount root to a subfolder of the Drive (default "/").
	Subpath string
	// ReadWrite allows mutations (PUT, MKCOL, MOVE, DELETE). Defaults to false (read-only).
	ReadWrite bool
	// IncludeProtected exposes protected paths (.git, .envrc, CLAUDE.md, etc.). Defaults to false.
	IncludeProtected bool
	// CacheTTL bounds how long directory listings are cached locally (default 3s).
	CacheTTL time.Duration
	// StagingDir holds 0600 temp files for buffered reads/writes; created with 0700 if empty.
	StagingDir string
}

// DriveFS implements golang.org/x/net/webdav.FileSystem over Caveman Drive with:
//   - fail-closed protected-path guards (matched at every depth),
//   - lazy reads + ContentTyper/ETager (PROPFIND/HEAD never download file bodies),
//   - safe PUT completion verification (aborted/oversized PUTs never commit),
//   - optimistic if_version support for share tokens and API keys,
//   - bounded 0600 temp staging quota and bounded directory/virtual-dir caches,
//   - ephemeral in-memory AppleDouble (._*) overlay on read-write mounts so macOS
//     Finder copies succeed without polluting the Drive's immutable commit log.
type DriveFS struct {
	client           *DriveClient
	subpath          string
	readWrite        bool
	includeProtected bool
	cacheTTL         time.Duration
	stagingDir       string
	ownsStagingDir   bool
	mountedAt        time.Time

	stagingBytes atomic.Int64

	mu          sync.Mutex
	dirCache    map[string]cachedDir
	virtualDirs map[string]time.Time
	appleDouble map[string]appleDoubleEntry
}

type cachedDir struct {
	entries []DriveFile
	expires time.Time
}

type appleDoubleEntry struct {
	data    []byte
	modTime time.Time
}

// NewDriveFS creates a hardened WebDAV filesystem backed by client.
func NewDriveFS(client *DriveClient, opts FSOptions) (*DriveFS, error) {
	if client == nil {
		return nil, errors.New("drive client is required")
	}
	sub := "/"
	if strings.TrimSpace(opts.Subpath) != "" {
		clean, ok := CleanDrivePath(opts.Subpath)
		if !ok {
			return nil, errors.New("invalid drive subpath")
		}
		if !opts.IncludeProtected && IsProtectedPath(clean) {
			return nil, errors.New("drive subpath is protected; pass --include-protected to mount it")
		}
		sub = clean
	}
	ttl := opts.CacheTTL
	if ttl <= 0 {
		ttl = 3 * time.Second
	}
	staging := opts.StagingDir
	owns := false
	if staging == "" {
		var err error
		staging, err = os.MkdirTemp("", "caveman-drive-stage-*")
		if err != nil {
			return nil, err
		}
		if err := os.Chmod(staging, 0o700); err != nil {
			_ = os.RemoveAll(staging)
			return nil, err
		}
		owns = true
	}
	return &DriveFS{
		client:           client,
		subpath:          sub,
		readWrite:        opts.ReadWrite,
		includeProtected: opts.IncludeProtected,
		cacheTTL:         ttl,
		stagingDir:       staging,
		ownsStagingDir:   owns,
		mountedAt:        time.Now().UTC().Truncate(time.Second),
		dirCache:         map[string]cachedDir{},
		virtualDirs:      map[string]time.Time{},
		appleDouble:      map[string]appleDoubleEntry{},
	}, nil
}

// VerifySubpath verifies that an explicitly configured non-root subpath exists
// in the remote Drive before announcing a successful mount.
func (d *DriveFS) VerifySubpath(ctx context.Context) error {
	if d.subpath == "/" {
		return nil
	}
	_, err := d.client.ListFiles(ctx, d.subpath, false)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return fmt.Errorf("drive subfolder %q does not exist", d.subpath)
		}
		return err
	}
	return nil
}

// Close removes the private temp staging directory created for this mount.
func (d *DriveFS) Close() error {
	if d.ownsStagingDir && d.stagingDir != "" {
		return os.RemoveAll(d.stagingDir)
	}
	return nil
}

func (d *DriveFS) reserveStaging(n int64) bool {
	if n <= 0 {
		return true
	}
	for {
		cur := d.stagingBytes.Load()
		if cur+n > maxTotalStagingBytes {
			return false
		}
		if d.stagingBytes.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

func (d *DriveFS) releaseStaging(n int64) {
	if n > 0 {
		d.stagingBytes.Add(-n)
	}
}

var (
	errOSJunk      = errors.New("os metadata junk path")
	errAppleDouble = errors.New("macos appledouble metadata path")
)

func (d *DriveFS) resolve(name string) (rel string, remote string, err error) {
	clean, ok := CleanDrivePath(name)
	if !ok {
		return "", "", os.ErrPermission
	}
	if IsAppleDoublePath(clean) {
		return clean, "", errAppleDouble
	}
	if IsOSJunkPath(clean) {
		return clean, "", errOSJunk
	}
	if !d.includeProtected && IsProtectedPath(clean) {
		return "", "", os.ErrPermission
	}
	full := JoinDriveSubpath(d.subpath, clean)
	if !d.includeProtected && IsProtectedPath(full) {
		return "", "", os.ErrPermission
	}
	return clean, full, nil
}

// invalidate clears dirCache entries for relPaths, their parents, and all
// cached descendants (preventing stale subtrees after folder Rename/RemoveAll).
func (d *DriveFS) invalidate(relPaths ...string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(relPaths) == 0 {
		clear(d.dirCache)
		return
	}
	for _, p := range relPaths {
		delete(d.dirCache, p)
		delete(d.dirCache, path.Dir(p))
		prefix := strings.TrimRight(p, "/") + "/"
		for k := range d.dirCache {
			if strings.HasPrefix(k, prefix) {
				delete(d.dirCache, k)
			}
		}
	}
}

func (d *DriveFS) listDir(ctx context.Context, relDir, remoteDir string) ([]DriveFile, error) {
	now := time.Now()
	d.mu.Lock()
	if c, ok := d.dirCache[relDir]; ok && now.Before(c.expires) {
		out := append([]DriveFile(nil), c.entries...)
		d.mu.Unlock()
		return out, nil
	}
	d.mu.Unlock()

	raw, err := d.client.ListFiles(ctx, remoteDir, false)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			d.mu.Lock()
			_, isVirtual := d.virtualDirs[relDir]
			d.mu.Unlock()
			if isVirtual || (relDir == "/" && d.subpath == "/") {
				return d.mergeVirtualChildren(relDir, nil), nil
			}
			return nil, os.ErrNotExist
		}
		if errors.Is(err, ErrPermission) {
			return nil, os.ErrPermission
		}
		return nil, err
	}

	prefix := strings.TrimRight(remoteDir, "/")
	filtered := make([]DriveFile, 0, len(raw))
	for _, f := range raw {
		// Validate every remote path returned by the API server before surfacing it.
		cleanRemote, ok := CleanDrivePath(f.Path)
		if !ok {
			continue
		}
		f.Path = cleanRemote
		if f.Path == remoteDir {
			continue
		}
		rel := strings.TrimPrefix(f.Path, prefix)
		if !strings.HasPrefix(rel, "/") {
			rel = "/" + rel
		}
		if IsOSJunkPath(rel) || IsAppleDoublePath(rel) {
			continue
		}
		if !d.includeProtected && (IsProtectedPath(rel) || IsProtectedPath(f.Path)) {
			continue
		}
		filtered = append(filtered, f)
	}
	filtered = d.mergeVirtualChildren(relDir, filtered)
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].Path < filtered[j].Path })

	d.mu.Lock()
	if len(d.dirCache) >= maxDirCacheEntries {
		for k, v := range d.dirCache {
			if !now.Before(v.expires) {
				delete(d.dirCache, k)
			}
		}
		if len(d.dirCache) >= maxDirCacheEntries {
			clear(d.dirCache)
		}
	}
	d.dirCache[relDir] = cachedDir{entries: append([]DriveFile(nil), filtered...), expires: time.Now().Add(d.cacheTTL)}
	d.mu.Unlock()
	return filtered, nil
}

func (d *DriveFS) mergeVirtualChildren(relDir string, existing []DriveFile) []DriveFile {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.virtualDirs) == 0 {
		return existing
	}
	seen := make(map[string]bool, len(existing))
	for _, f := range existing {
		seen[Key(path.Base(f.Path))] = true
	}
	for vrel, ts := range d.virtualDirs {
		if path.Dir(vrel) == relDir && vrel != "/" {
			baseKey := Key(path.Base(vrel))
			if !seen[baseKey] {
				existing = append(existing, DriveFile{
					Path:       JoinDriveSubpath(d.subpath, vrel),
					Kind:       "folder",
					ModifiedAt: ts,
				})
				seen[baseKey] = true
			}
		}
	}
	return existing
}

func sameSegmentPath(a, b string) bool {
	sa := splitPath(a)
	sb := splitPath(b)
	if len(sa) != len(sb) {
		return false
	}
	for i := range sa {
		if Key(sa[i]) != Key(sb[i]) {
			return false
		}
	}
	return true
}

func (d *DriveFS) lookup(ctx context.Context, rel, remote string) (DriveFile, bool, error) {
	if rel == "/" {
		return DriveFile{Path: remote, Kind: "folder", ModifiedAt: d.mountedAt}, true, nil
	}
	parentRel := path.Dir(rel)
	parentRemote := JoinDriveSubpath(d.subpath, parentRel)
	entries, err := d.listDir(ctx, parentRel, parentRemote)
	if err != nil {
		return DriveFile{}, false, err
	}
	for _, e := range entries {
		if e.Path == remote || sameSegmentPath(e.Path, remote) {
			return e, true, nil
		}
	}
	d.mu.Lock()
	ts, isVirtual := d.virtualDirs[rel]
	d.mu.Unlock()
	if isVirtual {
		return DriveFile{Path: remote, Kind: "folder", ModifiedAt: ts}, true, nil
	}
	return DriveFile{}, false, nil
}

// Mkdir records a virtual directory locally (Caveman Drive materializes folders
// on the first file written inside them), enforcing RFC 4918 parent/existence checks.
func (d *DriveFS) Mkdir(ctx context.Context, name string, perm os.FileMode) error {
	rel, remote, err := d.resolve(name)
	if errors.Is(err, errOSJunk) || errors.Is(err, errAppleDouble) {
		return os.ErrPermission
	}
	if err != nil {
		return err
	}
	if !d.readWrite {
		return os.ErrPermission
	}
	if rel == "/" {
		return os.ErrExist
	}
	parentRel := path.Dir(rel)
	if parentRel != "/" {
		parent, ok, lerr := d.lookup(ctx, parentRel, JoinDriveSubpath(d.subpath, parentRel))
		if lerr != nil {
			return lerr
		}
		if !ok || parent.Kind != "folder" {
			return os.ErrNotExist
		}
	}
	if _, exists, lerr := d.lookup(ctx, rel, remote); lerr == nil && exists {
		return os.ErrExist
	}
	d.mu.Lock()
	if len(d.virtualDirs) >= maxVirtualDirs {
		d.mu.Unlock()
		return errors.New("too many empty virtual directories")
	}
	d.virtualDirs[rel] = time.Now().UTC()
	d.mu.Unlock()
	d.invalidate(rel, parentRel)
	return nil
}

// RemoveAll deletes a file or folder recursively when readWrite is enabled.
func (d *DriveFS) RemoveAll(ctx context.Context, name string) error {
	rel, remote, err := d.resolve(name)
	if errors.Is(err, errAppleDouble) {
		d.mu.Lock()
		delete(d.appleDouble, rel)
		d.mu.Unlock()
		return nil
	}
	if errors.Is(err, errOSJunk) {
		return nil
	}
	if err != nil {
		return err
	}
	if !d.readWrite || rel == "/" {
		return os.ErrPermission
	}
	d.mu.Lock()
	_, wasVirtual := d.virtualDirs[rel]
	for k := range d.virtualDirs {
		if k == rel || strings.HasPrefix(k, rel+"/") {
			delete(d.virtualDirs, k)
		}
	}
	d.mu.Unlock()
	err = d.client.Delete(ctx, remote, true)
	if err != nil {
		if errors.Is(err, ErrNotFound) && wasVirtual {
			d.invalidate(rel, path.Dir(rel))
			return nil
		}
		return mapFSError(err)
	}
	d.invalidate(rel, path.Dir(rel))
	return nil
}

// Rename moves a file or folder within the mounted drive. Refuses moving into or
// out of protected paths, OS junk paths, or into a descendant of itself.
func (d *DriveFS) Rename(ctx context.Context, oldName, newName string) error {
	oldRel, oldRemote, err := d.resolve(oldName)
	if errors.Is(err, errAppleDouble) {
		newRel, _, nerr := d.resolve(newName)
		if errors.Is(nerr, errAppleDouble) && d.readWrite {
			d.mu.Lock()
			if entry, ok := d.appleDouble[oldRel]; ok {
				delete(d.appleDouble, oldRel)
				d.appleDouble[newRel] = entry
			}
			d.mu.Unlock()
			return nil
		}
		return os.ErrPermission
	}
	if err != nil {
		return os.ErrPermission
	}
	newRel, newRemote, err := d.resolve(newName)
	if err != nil {
		return os.ErrPermission
	}
	if !d.readWrite || oldRel == "/" || newRel == "/" {
		return os.ErrPermission
	}
	if newRel == oldRel || (!sameSegmentPath(oldRel, newRel) && pathsOverlap(oldRel, newRel)) {
		return os.ErrPermission
	}

	// Support renaming a newly created empty virtual directory (preserving any nested virtual children).
	d.mu.Lock()
	ts, wasVirtual := d.virtualDirs[oldRel]
	if wasVirtual {
		delete(d.virtualDirs, oldRel)
		d.virtualDirs[newRel] = ts
	}
	oldPrefix := oldRel + "/"
	movedChildren := make(map[string]time.Time)
	for k, cts := range d.virtualDirs {
		if strings.HasPrefix(k, oldPrefix) {
			delete(d.virtualDirs, k)
			movedChildren[newRel+strings.TrimPrefix(k, oldRel)] = cts
		}
	}
	for nk, cts := range movedChildren {
		d.virtualDirs[nk] = cts
	}
	d.mu.Unlock()
	if wasVirtual {
		d.invalidate(oldRel, newRel)
		return nil
	}

	if err := d.client.Move(ctx, oldRemote, newRemote); err != nil {
		return mapFSError(err)
	}
	d.invalidate(oldRel, newRel)
	return nil
}

// Stat returns metadata for a file or folder without downloading file contents.
func (d *DriveFS) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	rel, remote, err := d.resolve(name)
	if errors.Is(err, errAppleDouble) {
		if d.readWrite {
			d.mu.Lock()
			entry, ok := d.appleDouble[rel]
			d.mu.Unlock()
			if ok {
				return driveFileInfo{
					file:      DriveFile{Path: rel, Kind: "file", SizeBytes: int64(len(entry.data)), MediaType: "application/octet-stream", ModifiedAt: entry.modTime},
					readWrite: true,
				}, nil
			}
		}
		return nil, os.ErrNotExist
	}
	if errors.Is(err, errOSJunk) {
		return nil, os.ErrNotExist
	}
	if err != nil {
		return nil, err
	}
	f, ok, err := d.lookup(ctx, rel, remote)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, os.ErrNotExist
	}
	return driveFileInfo{file: f, readWrite: d.readWrite}, nil
}

// OpenFile opens a directory, a lazy read handle, or a staged 0600 write handle.
// Bare O_RDWR without O_TRUNC/O_CREATE is refused so PROPPATCH can never zero a file.
func (d *DriveFS) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (webdav.File, error) {
	rel, remote, err := d.resolve(name)
	if errors.Is(err, errAppleDouble) {
		if !d.readWrite {
			if isWriteFlag(flag) {
				return nil, os.ErrPermission
			}
			return nil, os.ErrNotExist
		}
		return d.openAppleDouble(rel, flag)
	}
	if errors.Is(err, errOSJunk) {
		if isWriteFlag(flag) {
			return nil, os.ErrPermission
		}
		return nil, os.ErrNotExist
	}
	if err != nil {
		return nil, err
	}

	writing := isWriteFlag(flag)
	if writing {
		if !d.readWrite {
			return nil, os.ErrPermission
		}
		if rel == "/" {
			return nil, os.ErrPermission
		}
		// Never open a fresh empty write handle unless truncation or creation was requested.
		if flag&(os.O_TRUNC|os.O_CREATE) == 0 {
			return nil, os.ErrPermission
		}
		if flag&os.O_APPEND != 0 {
			return nil, os.ErrInvalid
		}
		var existingVersion int64
		if existing, ok, lerr := d.lookup(ctx, rel, remote); lerr == nil && ok {
			if existing.Kind == "folder" {
				return nil, os.ErrInvalid
			}
			existingVersion = existing.Version
		}
		tmp, err := os.CreateTemp(d.stagingDir, "put-*")
		if err != nil {
			return nil, err
		}
		_ = tmp.Chmod(0o600)
		return &writeFile{
			fs:              d,
			reqCtx:          ctx,
			rel:             rel,
			remote:          remote,
			existingVersion: existingVersion,
			tmp:             tmp,
			tmpPath:         tmp.Name(),
		}, nil
	}

	f, ok, err := d.lookup(ctx, rel, remote)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, os.ErrNotExist
	}
	if f.Kind == "folder" {
		entries, err := d.listDir(ctx, rel, remote)
		if err != nil {
			return nil, err
		}
		infos := make([]os.FileInfo, 0, len(entries))
		for _, child := range entries {
			infos = append(infos, driveFileInfo{file: child, readWrite: d.readWrite})
		}
		return &dirFile{
			info:    driveFileInfo{file: f, readWrite: d.readWrite},
			entries: infos,
		}, nil
	}

	// Lazy read handle: PROPFIND/HEAD/Stat never download remote bytes.
	return &readFile{
		fs:     d,
		reqCtx: ctx,
		remote: f.Path,
		info:   driveFileInfo{file: f, readWrite: d.readWrite},
	}, nil
}

func (d *DriveFS) openAppleDouble(rel string, flag int) (webdav.File, error) {
	if isWriteFlag(flag) {
		if flag&(os.O_TRUNC|os.O_CREATE) == 0 {
			return nil, os.ErrPermission
		}
		return &appleDoubleWriteFile{fs: d, rel: rel}, nil
	}
	d.mu.Lock()
	entry, ok := d.appleDouble[rel]
	d.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return &appleDoubleReadFile{
		info: driveFileInfo{
			file:      DriveFile{Path: rel, Kind: "file", SizeBytes: int64(len(entry.data)), MediaType: "application/octet-stream", ModifiedAt: entry.modTime},
			readWrite: true,
		},
		r: bytes.NewReader(entry.data),
	}, nil
}

func isWriteFlag(flag int) bool {
	return flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC|os.O_APPEND) != 0
}

func mapFSError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotFound):
		return os.ErrNotExist
	case errors.Is(err, ErrPermission):
		return os.ErrPermission
	case errors.Is(err, ErrConflict), errors.Is(err, ErrVersionRequired):
		return os.ErrExist
	default:
		return err
	}
}

// ---- os.FileInfo + webdav.ContentTyper + webdav.ETager ----

type driveFileInfo struct {
	file      DriveFile
	readWrite bool
}

func (i driveFileInfo) Name() string {
	if i.file.Path == "" || i.file.Path == "/" {
		return "/"
	}
	return path.Base(i.file.Path)
}

func (i driveFileInfo) Size() int64 {
	if i.file.Kind == "folder" {
		return 0
	}
	return i.file.SizeBytes
}

func (i driveFileInfo) Mode() fs.FileMode {
	if i.file.Kind == "folder" {
		if i.readWrite {
			return fs.ModeDir | 0o755
		}
		return fs.ModeDir | 0o555
	}
	if i.readWrite {
		return 0o644
	}
	return 0o444
}

func (i driveFileInfo) ModTime() time.Time {
	if i.file.ModifiedAt.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return i.file.ModifiedAt
}

func (i driveFileInfo) IsDir() bool { return i.file.Kind == "folder" }
func (i driveFileInfo) Sys() any    { return nil }

// ContentType prevents x/net/webdav PROPFIND from opening and downloading files
// just to sniff MIME types.
func (i driveFileInfo) ContentType(context.Context) (string, error) {
	if i.file.Kind == "folder" {
		return "", nil
	}
	if strings.TrimSpace(i.file.MediaType) != "" {
		return i.file.MediaType, nil
	}
	return "application/octet-stream", nil
}

// ETag returns the Drive version ETag without downloading file content.
func (i driveFileInfo) ETag(context.Context) (string, error) {
	if i.file.Version > 0 {
		return fmt.Sprintf(`"%d"`, i.file.Version), nil
	}
	return fmt.Sprintf(`"%d-%d"`, i.ModTime().UnixNano(), i.Size()), nil
}

// ---- Directory handle ----

type dirFile struct {
	info    driveFileInfo
	entries []os.FileInfo
	offset  int
}

func (f *dirFile) Close() error                   { return nil }
func (f *dirFile) Read([]byte) (int, error)       { return 0, os.ErrInvalid }
func (f *dirFile) Write([]byte) (int, error)      { return 0, os.ErrPermission }
func (f *dirFile) Seek(int64, int) (int64, error) { return 0, os.ErrInvalid }
func (f *dirFile) Stat() (os.FileInfo, error)     { return f.info, nil }
func (f *dirFile) Readdir(count int) ([]os.FileInfo, error) {
	if count <= 0 {
		out := f.entries[f.offset:]
		f.offset = len(f.entries)
		return out, nil
	}
	if f.offset >= len(f.entries) {
		return nil, io.EOF
	}
	end := f.offset + count
	if end > len(f.entries) {
		end = len(f.entries)
	}
	out := f.entries[f.offset:end]
	f.offset = end
	return out, nil
}

// ---- Lazy read-only staged file handle ----

type readFile struct {
	fs       *DriveFS
	reqCtx   context.Context
	remote   string
	info     driveFileInfo
	mu       sync.Mutex
	pos      int64
	tmp      *os.File
	tmpPath  string
	reserved int64
}

type quotaStagingWriter struct {
	fs       *DriveFS
	dst      *os.File
	reserved int64
}

func (q *quotaStagingWriter) Write(p []byte) (int, error) {
	if q.reserved+int64(len(p)) > MaxMountFileBytes {
		return 0, ErrTooLarge
	}
	if !q.fs.reserveStaging(int64(len(p))) {
		return 0, ErrTooLarge
	}
	n, err := q.dst.Write(p)
	q.reserved += int64(n)
	if n < len(p) {
		q.fs.releaseStaging(int64(len(p) - n))
	}
	return n, err
}

func (f *readFile) recordCopyErr(err error) {
	if err != nil && !errors.Is(err, io.EOF) {
		if ct := copyTrackerFromContext(f.reqCtx); ct != nil {
			ct.RecordError(err)
		}
	}
}

func (f *readFile) ensureDownloaded() error {
	if f.tmp != nil {
		return nil
	}
	if f.info.Size() > MaxMountFileBytes {
		f.recordCopyErr(ErrTooLarge)
		return ErrTooLarge
	}
	tmp, err := os.CreateTemp(f.fs.stagingDir, "get-*")
	if err != nil {
		f.recordCopyErr(err)
		return err
	}
	_ = tmp.Chmod(0o600)
	qw := &quotaStagingWriter{fs: f.fs, dst: tmp}
	n, _, err := f.fs.client.Download(f.reqCtx, f.remote, qw)
	if err != nil {
		f.fs.releaseStaging(qw.reserved)
		tmpName := tmp.Name()
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		mapped := mapFSError(err)
		f.recordCopyErr(mapped)
		return mapped
	}
	if _, err := tmp.Seek(f.pos, io.SeekStart); err != nil {
		f.fs.releaseStaging(qw.reserved)
		tmpName := tmp.Name()
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		f.recordCopyErr(err)
		return err
	}
	f.tmp = tmp
	f.tmpPath = tmp.Name()
	f.reserved = qw.reserved
	f.info.file.SizeBytes = n
	return nil
}

func (f *readFile) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tmp == nil {
		return nil
	}
	err := f.tmp.Close()
	_ = os.Remove(f.tmpPath)
	f.fs.releaseStaging(f.reserved)
	f.tmp = nil
	f.reserved = 0
	return err
}

func (f *readFile) Read(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.ensureDownloaded(); err != nil {
		return 0, err
	}
	n, err := f.tmp.Read(p)
	f.pos += int64(n)
	if err != nil {
		f.recordCopyErr(err)
	}
	return n, err
}

func (f *readFile) Write([]byte) (int, error) { return 0, os.ErrPermission }

func (f *readFile) Seek(off int64, w int) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tmp != nil {
		pos, err := f.tmp.Seek(off, w)
		if err == nil {
			f.pos = pos
		}
		return pos, err
	}
	// Serve metadata-only seeks (such as http.ServeContent on HEAD) from verified
	// Drive metadata without downloading the file body.
	var base int64
	switch w {
	case io.SeekStart:
		base = 0
	case io.SeekCurrent:
		base = f.pos
	case io.SeekEnd:
		base = f.info.Size()
	default:
		return 0, os.ErrInvalid
	}
	next := base + off
	if next < 0 {
		return 0, os.ErrInvalid
	}
	f.pos = next
	return f.pos, nil
}

func (f *readFile) Readdir(int) ([]os.FileInfo, error) { return nil, os.ErrInvalid }
func (f *readFile) Stat() (os.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.info, nil
}

// ---- Write-through staged file handle ----

type writeFile struct {
	fs              *DriveFS
	reqCtx          context.Context
	rel             string
	remote          string
	existingVersion int64

	mu       sync.Mutex
	tmp      *os.File
	tmpPath  string
	reserved int64
	writeErr error
	closed   bool
}

func (f *writeFile) Read(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tmp.Read(p)
}

func (f *writeFile) Seek(off int64, w int) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tmp.Seek(off, w)
}

func (f *writeFile) Readdir(int) ([]os.FileInfo, error) { return nil, os.ErrInvalid }

func (f *writeFile) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	if f.reserved+int64(len(p)) > MaxMountFileBytes {
		f.writeErr = ErrTooLarge
		return 0, ErrTooLarge
	}
	if !f.fs.reserveStaging(int64(len(p))) {
		f.writeErr = ErrTooLarge
		return 0, ErrTooLarge
	}
	n, err := f.tmp.Write(p)
	f.reserved += int64(n)
	if n < len(p) {
		f.fs.releaseStaging(int64(len(p) - n))
	}
	if err != nil {
		f.writeErr = err
	}
	return n, err
}

func (f *writeFile) Stat() (os.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var sz int64
	if st, err := f.tmp.Stat(); err == nil {
		sz = st.Size()
	}
	return driveFileInfo{
		file: DriveFile{
			Path:       f.remote,
			Kind:       "file",
			SizeBytes:  sz,
			MediaType:  "application/octet-stream",
			ModifiedAt: time.Now().UTC(),
		},
		readWrite: true,
	}, nil
}

func (f *writeFile) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil
	}
	f.closed = true
	defer func() {
		_ = f.tmp.Close()
		_ = os.Remove(f.tmpPath)
		f.fs.releaseStaging(f.reserved)
		f.reserved = 0
	}()

	// Abort commit if any write error occurred, the request was cancelled, or
	// the HTTP PUT body did not complete cleanly (prevents partial-file corruption).
	if f.writeErr != nil {
		return f.writeErr
	}
	if f.reqCtx != nil && f.reqCtx.Err() != nil {
		return f.reqCtx.Err()
	}
	if tracker := putTrackerFromContext(f.reqCtx); tracker != nil && !tracker.CompletedCleanly() {
		return errors.New("aborted incomplete PUT upload")
	}
	if ct := copyTrackerFromContext(f.reqCtx); ct != nil && ct.Err() != nil {
		return ct.Err()
	}

	st, err := f.tmp.Stat()
	if err != nil {
		return err
	}
	size := st.Size()
	if size > MaxMountFileBytes {
		return ErrTooLarge
	}

	uploadAttempt := func(opt UploadOptions) error {
		if _, err := f.tmp.Seek(0, io.SeekStart); err != nil {
			return err
		}
		var body io.Reader = f.tmp
		if size == 0 {
			body = bytes.NewReader(nil)
		}
		uploadCtx, cancel := context.WithTimeout(f.reqCtx, 10*time.Minute)
		defer cancel()
		_, err := f.fs.client.Upload(uploadCtx, f.remote, body, size, opt)
		return err
	}

	var opt UploadOptions
	if f.fs.client.RequiresOptimisticVersion() {
		if f.existingVersion > 0 {
			opt = UploadOptions{IfVersion: f.existingVersion}
		} else {
			opt = UploadOptions{IfAbsent: true}
		}
	} else {
		opt = UploadOptions{Overwrite: true}
	}

	err = uploadAttempt(opt)
	// Fallback when a person-looking token is actually rejected with version_required,
	// or when a keyed credential raced with a newly created file.
	if errors.Is(err, ErrVersionRequired) || (f.fs.client.RequiresOptimisticVersion() && errors.Is(err, ErrConflict) && f.existingVersion == 0) {
		f.fs.invalidate(f.rel, path.Dir(f.rel))
		if latest, ok, lerr := f.fs.lookup(f.reqCtx, f.rel, f.remote); lerr == nil && ok && latest.Version > 0 {
			err = uploadAttempt(UploadOptions{IfVersion: latest.Version})
		} else if errors.Is(err, ErrVersionRequired) {
			err = uploadAttempt(UploadOptions{IfAbsent: true})
		}
	}
	if err != nil {
		return mapFSError(err)
	}

	// Clear any ancestor virtual directories now materialized in the drive.
	f.fs.mu.Lock()
	for cur := path.Dir(f.rel); cur != "/" && cur != "."; cur = path.Dir(cur) {
		delete(f.fs.virtualDirs, cur)
	}
	f.fs.mu.Unlock()
	f.fs.invalidate(f.rel, path.Dir(f.rel))
	return nil
}

// ---- Ephemeral macOS AppleDouble (._*) overlay (never uploaded to Drive) ----

type appleDoubleReadFile struct {
	info driveFileInfo
	r    *bytes.Reader
}

func (f *appleDoubleReadFile) Close() error                       { return nil }
func (f *appleDoubleReadFile) Read(p []byte) (int, error)         { return f.r.Read(p) }
func (f *appleDoubleReadFile) Write([]byte) (int, error)          { return 0, os.ErrPermission }
func (f *appleDoubleReadFile) Seek(o int64, w int) (int64, error) { return f.r.Seek(o, w) }
func (f *appleDoubleReadFile) Readdir(int) ([]os.FileInfo, error) { return nil, os.ErrInvalid }
func (f *appleDoubleReadFile) Stat() (os.FileInfo, error)         { return f.info, nil }

type appleDoubleWriteFile struct {
	fs  *DriveFS
	rel string
	buf bytes.Buffer
}

func (f *appleDoubleWriteFile) Read([]byte) (int, error)       { return 0, os.ErrInvalid }
func (f *appleDoubleWriteFile) Seek(int64, int) (int64, error) { return 0, os.ErrInvalid }
func (f *appleDoubleWriteFile) Readdir(int) ([]os.FileInfo, error) {
	return nil, os.ErrInvalid
}
func (f *appleDoubleWriteFile) Write(p []byte) (int, error) {
	if f.buf.Len()+len(p) > maxAppleDoubleBytes {
		return 0, ErrTooLarge
	}
	return f.buf.Write(p)
}
func (f *appleDoubleWriteFile) Stat() (os.FileInfo, error) {
	return driveFileInfo{
		file:      DriveFile{Path: f.rel, Kind: "file", SizeBytes: int64(f.buf.Len()), MediaType: "application/octet-stream", ModifiedAt: time.Now().UTC()},
		readWrite: true,
	}, nil
}
func (f *appleDoubleWriteFile) Close() error {
	f.fs.mu.Lock()
	defer f.fs.mu.Unlock()
	if len(f.fs.appleDouble) >= maxAppleDoubleItems {
		clear(f.fs.appleDouble)
	}
	f.fs.appleDouble[f.rel] = appleDoubleEntry{
		data:    append([]byte(nil), f.buf.Bytes()...),
		modTime: time.Now().UTC(),
	}
	return nil
}
