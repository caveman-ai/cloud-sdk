package cavemancloud

import (
	"context"
	"net/http"
	"time"
)

// A sandbox's port at its own URL (https://<port>-<sandbox>.<domain>), where the Caveman Cloud serves
// ports so (computers.portUrls; elsewhere the routes are refused, 404 or 405): a token and a link
// from the API (PortToken), the port made public or private (SetPort), the choices stored (Ports).
// A port's dial (DialPort) is a stream at the relay that needs no URL.

// SandboxPortURL is a sandbox's port at its own URL, as URL answers it. A program sends Headers
// (Caveman-Port-Token; the relay takes it off) with each request to URL, until ExpiresAt. A person
// opens Link in a browser before LinkExpiresAt (a few minutes; it is a credential while it lasts),
// and the browser then holds a cookie for that host alone until ExpiresAt. Visibility is the
// port's now: private (a token opens it) or public (anyone with the address).
type SandboxPortURL struct {
	URL           string
	Link          string
	LinkExpiresAt time.Time
	Token         string
	Headers       http.Header
	ExpiresAt     time.Time
	Visibility    string
}

// URLOptions are URL's options. TTL is how long the token, and the cookie a link leaves, open the
// port: whole seconds from a minute to a day, an hour when zero. Public, when set, first makes the
// port public (true: anyone with the address reaches it; the sandbox's maker alone may) or private
// again (false); nil leaves it as it is.
type URLOptions struct {
	TTL    time.Duration
	Public *bool
}

// URL answers port of a sandbox at its own URL: its token and a link (POST
// /code/computers/{computerId}/ports/{port}/token), after setting its visibility when
// options.Public says to. The token stops working once the key is revoked or the sandbox deleted.
// A port or a TTL out of range is refused here, before anything is sent (cave_bad_request).
func (s *Sandboxes) URL(ctx context.Context, sandboxID string, port int, options URLOptions) (SandboxPortURL, error) {
	if port < 1 || port > 65535 {
		return SandboxPortURL{}, &Error{Code: "cave_bad_request", Message: "The port is a number from 1 to 65535."}
	}
	var input SandboxesPortTokenInput
	if options.TTL != 0 {
		if options.TTL < time.Minute || options.TTL > 24*time.Hour || options.TTL%time.Second != 0 {
			return SandboxPortURL{}, &Error{Code: "cave_bad_request", Message: "TTL is whole seconds from a minute to a day."}
		}
		seconds := int(options.TTL / time.Second)
		input.TtlSeconds = &seconds
	}
	if options.Public != nil {
		visibility := "private"
		if *options.Public {
			visibility = "public"
		}
		if _, err := s.SetPort(ctx, sandboxID, port, SandboxesSetPortInput{Visibility: visibility}); err != nil {
			return SandboxPortURL{}, err
		}
	}
	t, err := s.PortToken(ctx, sandboxID, port, input)
	if err != nil {
		return SandboxPortURL{}, err
	}
	linkExpires, err1 := time.Parse(time.RFC3339, t.LinkExpiresAt)
	expires, err2 := time.Parse(time.RFC3339, t.ExpiresAt)
	if err1 != nil || err2 != nil || t.Token == "" || t.Header == "" {
		return SandboxPortURL{}, &Error{Code: "cave_response_invalid", Message: "The port's token answer is not one this SDK reads.", Status: http.StatusOK}
	}
	headers := http.Header{}
	headers.Set(t.Header, t.Token)
	return SandboxPortURL{URL: t.Url, Link: t.Link, LinkExpiresAt: linkExpires, Token: t.Token, Headers: headers, ExpiresAt: expires, Visibility: t.Visibility}, nil
}
