# Caveman in LiteLLM

```sh
# From this directory, in the Python environment that runs your LiteLLM proxy:
python -m pip install '.[litellm,tracing]'
export CAVE_API_KEY='your-project-key-with-router:write'
caveman-router setup --config /path/to/config.yaml
caveman-router check --config /path/to/config.caveman.yaml
# Retain general_settings.master_key or set LITELLM_MASTER_KEY in this environment.
litellm --config /path/to/config.caveman.yaml
```

The pinned LiteLLM release requires a master key and refuses to start without one.
Keep an existing deployment's key in `general_settings.master_key` or
`LITELLM_MASTER_KEY`; Caveman setup preserves it. For a new deployment, generate a
key with `openssl rand -hex 32` and store it as `LITELLM_MASTER_KEY` in the proxy's
deployment secrets. Follow LiteLLM's [rotation procedure](https://docs.litellm.ai/docs/proxy/master_key_rotations)
when replacing an existing key.

```sh
# Deployment aliases or a selected pool:
caveman-router setup --config config.yaml --router "$CAVEMAN_ROUTER_URL" \
  --models production-eu,economy-eu \
  --map production-eu=openai/gpt-4o --map economy-eu=openai/gpt-4o-mini

# Optional router authentication; provider keys stay in the LiteLLM config:
export CAVEMAN_ROUTER_TOKEN='your-router-token'
```

- Setup options: `caveman-router setup --help`.
- Generic embedding API: [`RouterClient`](caveman_router_client.py).
- LiteLLM callback: [`CavemanRouterHook`](caveman_router.py).
- Executable compatibility cases: [`test_litellm_conformance.py`](test_litellm_conformance.py).
- Dependency pins: [`requirements-test.txt`](requirements-test.txt).
