"""Tests for per-request optimization control (``x-cave-optimize``) and the
response-receipt parser. Mirrors the TS tests/optimize.runtime.mjs."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from caveman_cloud import Cave, gateway_config, gateway_headers, parse_receipt


def _fake_response(data: dict[str, Any]) -> MagicMock:
    body = json.dumps(data).encode()
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=MagicMock(read=MagicMock(return_value=body)))
    cm.__exit__ = MagicMock(return_value=False)
    return cm


def _cave() -> Cave:
    return Cave(api_key="cave_live_test_key", base_url="http://localhost:8787", agent="a")


def _capture() -> tuple[list[dict[str, str]], Any]:
    """A urlopen stub plus the list it records lowercased headers into."""
    captured: list[dict[str, str]] = []

    def fake_urlopen(req: Any, timeout: float) -> MagicMock:  # noqa: ANN401
        captured.append({k.lower(): v for k, v in dict(req.headers).items()})
        return _fake_response({"id": "resp_1"})

    return captured, fake_urlopen


# --- Option -> header serialization ----------------------------------------


def test_no_optimize_option_sends_no_header() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"})
    assert "x-cave-optimize" not in captured[0]


def test_optimize_off_sends_the_pass_through_token() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize="off")
    assert captured[0]["x-cave-optimize"] == "off"


def test_false_fields_serialize_in_a_stable_order() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        # Declared out of order on purpose: the header order must not follow the dict's.
        _cave().openai().chat["completions"].create(
            {"model": "gpt-4o", "messages": []},
            optimize={"routing": False, "cache_hints": False, "compress": False},
        )
    assert captured[0]["x-cave-optimize"] == "no-compress,no-cache,no-route"


def test_single_false_field_sends_only_that_token() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize={"compress": False})
    assert captured[0]["x-cave-optimize"] == "no-compress"


def test_empty_optimize_dict_narrows_nothing_so_the_header_is_omitted() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize={})
    assert "x-cave-optimize" not in captured[0]


def test_none_field_value_reads_as_absent_so_the_idiomatic_conditional_works() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        # `{"compress": False if flag else None}` is how callers write this; the
        # None arm must be a no-op, matching the TS `undefined`/`null`.
        _cave().openai().responses.create(
            {"model": "gpt-4o", "input": "hi"},
            optimize={"compress": None, "cache_hints": None, "routing": False},
        )
    assert captured[0]["x-cave-optimize"] == "no-route"


def test_optimize_flows_through_a_trace_scoped_provider_call() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with _cave().trace() as t:
            t.model["openai"].responses.create({"model": "gpt-4o", "input": "hi"}, optimize={"routing": False})
    assert captured[0]["x-cave-optimize"] == "no-route"


# --- Asking for an optimization (gateway v1 opt-up) -------------------------


def test_true_fields_ask_for_the_optimization() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create(
            {"model": "gpt-4o", "input": "hi"}, optimize={"routing": True, "compress": True}
        )
    assert captured[0]["x-cave-optimize"] == "compress,route"


def test_opt_up_and_opt_down_mix_in_one_header() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create(
            {"model": "gpt-4o", "input": "hi"}, optimize={"compress": True, "cache_hints": False}
        )
    assert captured[0]["x-cave-optimize"] == "compress,no-cache"


def test_style_is_serialized_last() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create(
            {"model": "gpt-4o", "input": "hi"}, optimize={"style": "caveman", "compress": True}
        )
    assert captured[0]["x-cave-optimize"] == "compress,style=caveman"


def test_compress_lossless_asks_for_the_lossless_tier_only() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create(
            {"model": "gpt-4o", "input": "hi"}, optimize={"compress": "lossless", "cache_hints": False}
        )
        with pytest.raises(ValueError, match="must be True"):
            _cave().openai().responses.create(
                {"model": "gpt-4o", "input": "hi"}, optimize={"routing": "lossless"}
            )
    assert [c["x-cave-optimize"] for c in captured] == ["compress=lossless,no-cache"]


def test_unknown_optimize_value_field_or_style_raises() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with pytest.raises(ValueError, match="unknown optimize value"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize="on")
        with pytest.raises(ValueError, match="unknown optimize field"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize={"compres": False})
        with pytest.raises(ValueError, match="unknown optimize style"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize={"style": "terse"})
        with pytest.raises(ValueError, match="must be True"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, optimize={"compress": "yes"})
    assert captured == [], "nothing may reach the wire"


# --- Response cache (x-cave-cache / x-cave-cache-key) -----------------------


def test_no_cache_option_sends_no_header() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"})
    assert "x-cave-cache" not in captured[0] and "x-cave-cache-key" not in captured[0]


def test_cache_modes_and_ttl_serialize() -> None:
    for option, expected in (
        ("force", "force"),
        ("disable", "disable"),
        ({"ttl_seconds": 900}, "ttl=900"),
        ("semantic", "semantic"),
        ({"ttl_seconds": 900, "semantic": True}, "semantic,ttl=900"),
        # semantic=False is the exact-match form, not a second spelling of it.
        ({"ttl_seconds": 900, "semantic": False}, "ttl=900"),
    ):
        captured, fake_urlopen = _capture()
        with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, cache=option)
        assert captured[0]["x-cave-cache"] == expected


def test_cache_key_is_sent_and_validated() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        _cave().openai().responses.create(
            {"model": "gpt-4o", "input": "hi"}, cache="force", cache_key="tenant-42:eu"
        )
    assert captured[0]["x-cave-cache-key"] == "tenant-42:eu"
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with pytest.raises(ValueError, match="cache_key must be"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, cache_key="a" * 129)
        with pytest.raises(ValueError, match="cache_key must be"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, cache_key="bad key")
    assert captured == []


def test_bad_cache_option_raises_before_the_wire() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with pytest.raises(ValueError, match="unknown cache value"):
            _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, cache="respect")
        bad: Any
        for bad in ({"ttl_seconds": 0}, {"ttl_seconds": -1}, {"ttl_seconds": 1.5}, {"ttl_seconds": True}, {}):
            with pytest.raises(ValueError, match="ttl_seconds"):
                _cave().openai().responses.create({"model": "gpt-4o", "input": "hi"}, cache=bad)
        with pytest.raises(ValueError, match="cache.semantic must be"):
            invalid_semantic: dict[str, Any] = {"ttl_seconds": 900, "semantic": "yes"}
            _cave().openai().responses.create(
                {"model": "gpt-4o", "input": "hi"}, cache=invalid_semantic
            )
    assert captured == []


# --- Response receipt -------------------------------------------------------


def test_parse_receipt_reads_every_disclosure_header() -> None:
    receipt = parse_receipt(
        {
            "x-cave-mode": "optimize",
            "x-cave-optimization": "caveman-compression, anthropic-cache-breakpoints",
            "x-cave-cache-status": "hit",
            "x-cave-request-id": "req_123",
            "x-caveman-compression-ratio": "0.6000",
            "x-caveman-tokens-before": "1200",
            "x-caveman-tokens-after": "720",
            "x-caveman-recovery-handle": "ccr_abc",
        }
    )
    assert receipt.mode == "optimize"
    assert receipt.optimizations == ["caveman-compression", "anthropic-cache-breakpoints"]
    assert receipt.cache_status == "hit"
    assert receipt.request_id == "req_123"
    assert receipt.compression_ratio == 0.6
    assert receipt.tokens_before == 1200
    assert receipt.tokens_after == 720
    assert receipt.recovery_handle == "ccr_abc"


def test_parse_receipt_reads_the_v1_gateway_disclosures() -> None:
    receipt = parse_receipt(
        {
            "x-cave-optimize-applied": "compress, route",
            "x-cave-optimize-denied": "cache-hints=eval_gate,style=pass_through",
            "x-cave-cache-mode": "force",
            "x-cave-response-cache": "hit",
        }
    )
    assert receipt.optimize_applied == ["compress", "route"]
    assert receipt.optimize_denied == {"cache-hints": "eval_gate", "style": "pass_through"}
    assert receipt.cache_mode == "force"
    # A hit is an avoided provider call — the receipt states the outcome and
    # nothing else; no savings figure is derived from it.
    assert receipt.response_cache == "hit"
    assert receipt.compression_ratio is None


def test_semantic_outcome_is_disclosed_with_its_score_and_mints_nothing() -> None:
    hit = parse_receipt(
        {
            "x-cave-cache-mode": "semantic",
            "x-cave-response-cache": "hit_semantic",
            "x-cave-semantic-similarity": "0.94",
        }
    )
    # The receipt states the outcome and the score. No savings figure follows
    # from either: a semantic hit is an avoided call worth zero verified savings.
    assert hit.cache_mode == "semantic"
    assert hit.response_cache == "hit_semantic"
    assert hit.semantic_similarity == 0.94
    # Shadow mode scores the match but the provider still answered.
    shadow = parse_receipt({"x-cave-response-cache": "shadow_miss", "x-cave-semantic-similarity": "0.5"})
    assert shadow.response_cache == "shadow_miss"
    assert shadow.semantic_similarity == 0.5
    # Same number grammar as every other receipt float — no exponents.
    assert parse_receipt({"x-cave-semantic-similarity": "9.4e-1"}).semantic_similarity is None


def test_gateway_headers_match_what_the_client_puts_on_the_wire() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        Cave(
            api_key="cave_live_test_key",
            base_url="http://localhost:8787",
            agent="a",
            default_workflow="w",
        ).openai().responses.create(
            {"model": "gpt-4o", "input": "hi"},
            optimize={"compress": True, "style": "caveman"},
            cache={"ttl_seconds": 900},
            cache_key="tenant-42",
        )
    helper = gateway_headers(
        api_key="cave_live_test_key",
        base_url="http://localhost:8787",
        agent="a",
        workflow="w",
        optimize={"compress": True, "style": "caveman"},
        cache={"ttl_seconds": 900},
        cache_key="tenant-42",
    )
    assert helper == captured[0]
    config = gateway_config(api_key="cave_live_test_key", base_url="http://localhost:8787/", agent="a")
    assert config["base_url"] == "http://localhost:8787"
    # A vendor SDK sets its own content-type per request; pinning it would break
    # multipart uploads.
    assert "content-type" not in config["default_headers"]
    assert config["default_headers"]["authorization"] == "Bearer cave_live_test_key"


def test_parse_receipt_is_case_insensitive_and_reads_none() -> None:
    receipt = parse_receipt({"X-Cave-Mode": "record", "X-Cave-Optimization": "none"})
    assert receipt.mode == "record"
    assert receipt.optimizations == []


def test_absent_headers_leave_none_fields_nothing_is_fabricated() -> None:
    receipt = parse_receipt({"x-cave-mode": "record"})
    assert receipt.mode == "record"
    assert receipt.optimizations is None
    assert receipt.compression_ratio is None
    empty = parse_receipt({})
    assert empty.mode is None and empty.optimizations is None and empty.recovery_handle is None


def test_unparseable_numeric_disclosure_is_dropped_not_guessed() -> None:
    receipt = parse_receipt(
        {
            "x-caveman-compression-ratio": "not-a-number",
            "x-caveman-tokens-before": "-3",
            "x-caveman-tokens-after": "12.5",
        }
    )
    assert receipt.compression_ratio is None
    assert receipt.tokens_before is None
    assert receipt.tokens_after is None


def test_only_plain_decimals_parse_matching_sdk_ts() -> None:
    # Empty, hex, exponent, infinity, and stray signs are all dropped on both sides.
    for raw in ("", " ", "0x10", "1e3", "Infinity", "+5", "5."):
        assert parse_receipt({"x-caveman-tokens-before": raw}).tokens_before is None, f"int {raw!r}"
        assert parse_receipt({"x-caveman-compression-ratio": raw}).compression_ratio is None, f"ratio {raw!r}"
    # Surrounding whitespace is tolerated; the value is not.
    assert parse_receipt({"x-caveman-tokens-before": " 42 "}).tokens_before == 42
    # Beyond the safe-integer ceiling both SDKs drop rather than round.
    assert parse_receipt({"x-caveman-tokens-before": "9007199254740993"}).tokens_before is None
