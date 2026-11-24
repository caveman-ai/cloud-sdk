# caveman-router changelog

## 0.2.3 (2026-11-11)

- The `litellm` extra moves to `litellm[proxy]==1.108.3` and `filelock==4.2.4`. Every filelock before 4.2.1, 3.20.3 included, is affected by GHSA-69hj-f68j-2879 (CVE-2026-112909) and, from 3.10.0, GHSA-8mx5-7m5m-r77g (CVE-2026-112910). LiteLLM 1.104 to 1.108.2 need filelock below 4.0; 1.108.3 is the first that takes a fixed one. The conformance suite runs against 1.108.3.

## 0.2.2 (2026-10-25)

- The `litellm` extra pins `filelock==3.20.3`. LiteLLM 1.106.2 needs filelock below 4.0, and every release from 3.20.4 to 4.2.0 is affected by GHSA-v4x8-3wr5-3wq8 (CVE-2026-112940), GHSA-9vhv-jxww-xfm5 and, from 3.22.0, GHSA-567q-5qvw-pf92, which 4.2.1 fixes.

## 0.2.0 (2026-10-19)

- The decision request sends the conversation as `messages`, bounded to Caveman Cloud's request caps, instead of one compacted `text`: the latest ask (its end, when it is over 60 KiB), the ask before it, the agent's reply before it, and a `…` stand-in for each earlier ask so Cloud can count the turn. Cloud reads the ask, the previous ask and the reply from them; system prompts and tool output are never sent.
- Any `200` answer naming a model of the pool is followed, and its `reason` is kept (`decided` when Cloud names none). Cloud now decides in process and no longer answers `ranked`; it names the requested model when it makes no decision, with `no_alternative`, `no_features`, `allowance` or `billing_limit`.
- `caveman-router check` exits 0 only on a decision Cloud made (`ask_*`, `easy_turn`, `hard_turn`, `no_cheaper_model`, or `ranked` / `exploration` from a Cloud not yet upgraded) and explains the answers that are not one.
- The hook warns once when Cloud pauses routing (`allowance`, `billing_limit`) or cannot read the ask (`no_features`).
- The `router_fallback` reason is gone.

## 0.1.1

- Security fixes from the 2026-10-01 audit.

## 0.1.0

- First release: the LiteLLM callback, `RouterClient` and the `caveman-router` setup CLI.
