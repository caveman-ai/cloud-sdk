package drivemount

import (
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	// MaxSegmentBytes, MaxPathBytes, MaxDepth, and MaxKeyBytes mirror drivepath.
	MaxSegmentBytes = 255
	MaxPathBytes    = 1024
	MaxDepth        = 64
	MaxKeyBytes     = 1024
)

// Protected folders and files match the server-side drivepath protection list:
// paths that tools, shells, editors, or coding agents auto-execute or obey from
// the directory they find them in. Checked at EVERY path depth so neither
// /.git/config nor /CLAUDE.md/sub can sneak past.
var (
	protectedFolders = []string{
		".caveman", ".agents", ".claude", ".codex", ".cursor", ".gemini",
		".windsurf", ".cline", ".roo", ".continue", ".kiro", ".amazonq",
		".opencode", ".aider", ".zed", ".idea", ".vscode", ".devcontainer",
		".git", ".github", ".husky",
	}
	protectedFiles = []string{
		"AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "SKILL.md",
		"agent.json", ".mcp.json", "opencode.json", ".cursorrules",
		".windsurfrules", ".clinerules", ".rules", ".aider.conf.yml", ".envrc",
	}

	unicodeFold = cases.Fold()

	protectedAllKeys = buildProtectedKeys(append(append([]string(nil), protectedFolders...), protectedFiles...))

	shortNameRe       = regexp.MustCompile(`^(.*?)~[1-9]\d{0,3}$`)
	shortHexPrefixRe  = regexp.MustCompile(`^[a-z0-9]{2}[0-9a-f]{4}$`)
	windowsReservedRe = regexp.MustCompile(`^(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9]) *(\.|$)`)
)

type protectedKeySet struct {
	names   map[string]struct{}
	letters []string
}

func buildProtectedKeys(items []string) protectedKeySet {
	ks := protectedKeySet{
		names:   make(map[string]struct{}, len(items)),
		letters: make([]string, 0, len(items)*2),
	}
	seen := map[string]struct{}{}
	addLetters := func(l string) {
		if l == "" {
			return
		}
		if _, ok := seen[l]; !ok {
			seen[l] = struct{}{}
			ks.letters = append(ks.letters, l)
		}
	}
	for _, item := range items {
		f := foldName(item)
		ks.names[f] = struct{}{}
		addLetters(lettersOnly(f))
		// Also record the extension-stripped stem so Windows 8.3 names like
		// AGENT~1.JSO (from agent.json) and MCP~1.JSO (from .mcp.json) match.
		trimmed := strings.TrimLeft(f, ".")
		if dot := strings.LastIndexByte(trimmed, '.'); dot > 0 {
			addLetters(lettersOnly(trimmed[:dot]))
		}
	}
	return ks
}

// isDefaultIgnorable reports Unicode Default_Ignorable_Code_Point runes that
// macOS APFS/HFS+ ignore during case-insensitive comparison even when not in Cf
// (e.g., U+034F Combining Grapheme Joiner, U+FE00..U+FE0F Variation Selectors).
func isDefaultIgnorable(r rune) bool {
	if unicode.Is(unicode.Cf, r) {
		return true
	}
	switch {
	case r == 0x034F, r == 0x061C, r == 0x115F, r == 0x1160, r == 0x17B4, r == 0x17B5, r == 0x3164, r == 0xFFA0:
		return true
	case r >= 0x180B && r <= 0x180F:
		return true
	case r >= 0xFE00 && r <= 0xFE0F:
		return true
	case r >= 0xE0100 && r <= 0xE01EF:
		return true
	}
	return false
}

// Key computes the canonical comparison key matching drivepath.Key (NFKC ->
// full Unicode case fold -> NFKC).
func Key(name string) string {
	return norm.NFKC.String(unicodeFold.String(norm.NFKC.String(name)))
}

// foldName normalizes a filename for protected-path comparison across APFS/NTFS:
// full Unicode case folding + NFKC, dropping default-ignorable runes and
// trailing dots/spaces.
func foldName(name string) string {
	s := Key(name)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if isDefaultIgnorable(r) {
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimRight(b.String(), ". ")
}

func lettersOnly(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// matchesProtectedKey checks exact folded key match plus strict Windows 8.3
// short-name aliases (exact full stem for <=6-letter names like GIT~1, exact
// 6-char prefix for longer names like CLAUDE~1 / CURSOR~1, or 2-char + 4-hex
// hash-collision short names like CL1A2B~1).
func matchesProtectedKey(key string, set protectedKeySet) bool {
	if _, ok := set.names[key]; ok {
		return true
	}
	// Trim leading dots (e.g., .ENVRC~1) then strip extension (e.g., CLAUDE~1.MD -> CLAUDE~1).
	base := strings.TrimLeft(key, ".")
	if dot := strings.LastIndexByte(base, '.'); dot >= 0 {
		base = base[:dot]
	}
	m := shortNameRe.FindStringSubmatch(base)
	if len(m) < 2 {
		return false
	}
	stem := lettersOnly(m[1])
	if len(stem) < 3 {
		return false
	}
	hexPref := shortHexPrefixRe.MatchString(stem)
	for _, candidate := range set.letters {
		if len(candidate) <= 6 {
			if stem == candidate {
				return true
			}
		} else if len(stem) == 6 && strings.HasPrefix(candidate, stem) {
			return true
		}
		if hexPref && len(candidate) >= 2 && strings.HasPrefix(candidate, stem[:2]) {
			return true
		}
	}
	return false
}

// IsProtectedPath reports whether relPath has ANY segment matching a protected
// folder or file name (matching drivepath.Protected at every depth).
func IsProtectedPath(relPath string) bool {
	for _, seg := range splitPath(relPath) {
		key := foldName(seg)
		if matchesProtectedKey(key, protectedAllKeys) {
			return true
		}
	}
	return false
}

// IsAppleDoublePath reports whether relPath is a macOS Finder AppleDouble
// metadata sidecar file (._*).
func IsAppleDoublePath(relPath string) bool {
	segs := splitPath(relPath)
	if len(segs) == 0 {
		return false
	}
	return strings.HasPrefix(segs[len(segs)-1], "._")
}

// IsOSJunkPath reports whether relPath is macOS Finder or Windows Explorer
// metadata noise (.DS_Store, ._*, Thumbs.db, desktop.ini, .Spotlight-V100,
// .Trashes, .fseventsd, etc.), folded against NFKC/case/trailing-dot variants.
func IsOSJunkPath(relPath string) bool {
	segs := splitPath(relPath)
	for i, seg := range segs {
		folded := foldName(seg)
		switch folded {
		case ".ds_store", "thumbs.db", "desktop.ini",
			".spotlight-v100", ".trashes", ".fseventsd",
			".temporaryitems", ".documentrevisions-v100",
			".volumeicon.icns", "$recycle.bin", "system volume information":
			return true
		}
		if i == len(segs)-1 && strings.HasPrefix(folded, "._") {
			return true
		}
	}
	return false
}

// IsUnsafeSegment reports whether a single path component is invalid or unsafe
// across POSIX, macOS APFS, Windows NTFS, and Caveman Drive (drivepath.Name).
func IsUnsafeSegment(seg string) bool {
	if seg == "" || !utf8.ValidString(seg) {
		return true
	}
	nfc := norm.NFC.String(seg)
	if len(nfc) > MaxSegmentBytes || nfc == "." || nfc == ".." {
		return true
	}
	if strings.HasPrefix(nfc, " ") || strings.HasSuffix(nfc, " ") || strings.HasSuffix(nfc, ".") {
		return true
	}
	if windowsReservedRe.MatchString(nfc) {
		return true
	}
	for _, r := range nfc {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', utf8.RuneError:
			return true
		}
		if isDefaultIgnorable(r) || unicode.In(r, unicode.Cc, unicode.Co, unicode.Cs, unicode.Zl, unicode.Zp) || (!unicode.IsPrint(r) && r != ' ') {
			return true
		}
	}
	if len(Key(nfc)) > MaxKeyBytes {
		return true
	}
	return false
}

// CleanDrivePath normalizes a WebDAV request path into a canonical NFC Drive
// path starting with "/" and rejects traversal, invalid UTF-8, default-ignorable
// marks, backslashes, excessive depth/length, or unsafe cross-platform names.
func CleanDrivePath(raw string) (string, bool) {
	if raw == "" {
		return "/", true
	}
	if len(raw) > MaxPathBytes || !utf8.ValidString(raw) {
		return "", false
	}
	if strings.ContainsRune(raw, '\\') || strings.ContainsRune(raw, '\x00') {
		return "", false
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == "." || seg == ".." {
			return "", false
		}
	}
	cleaned := path.Clean("/" + raw)
	if cleaned == "/" {
		return "/", true
	}
	segs := splitPath(cleaned)
	if len(segs) > MaxDepth {
		return "", false
	}
	total := 0
	normalized := make([]string, 0, len(segs))
	for _, seg := range segs {
		if IsUnsafeSegment(seg) {
			return "", false
		}
		nfc := norm.NFC.String(seg)
		total += len(nfc) + 1
		if total > MaxPathBytes {
			return "", false
		}
		normalized = append(normalized, nfc)
	}
	return "/" + strings.Join(normalized, "/"), true
}

// JoinDriveSubpath scopes a relative mount path under an optional drive subpath.
func JoinDriveSubpath(baseSubpath, relPath string) string {
	base := strings.Trim(baseSubpath, "/")
	rel := strings.Trim(relPath, "/")
	if base == "" && rel == "" {
		return "/"
	}
	if base == "" {
		return "/" + rel
	}
	if rel == "" {
		return "/" + base
	}
	return "/" + base + "/" + rel
}

// SanitizeTerminalText strips C0/C1/Cf control sequences so untrusted remote
// error strings can never inject ANSI escapes into a developer's terminal.
func SanitizeTerminalText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '\n' || r == '\t' || r == ' ' {
			b.WriteByte(' ')
			continue
		}
		if unicode.IsControl(r) || isDefaultIgnorable(r) || r == utf8.RuneError {
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

func splitPath(p string) []string {
	trimmed := strings.Trim(p, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}
