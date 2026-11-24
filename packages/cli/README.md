# cvm — the Caveman Cloud CLI

Every Caveman Cloud operation from the terminal, plus the Cloud MCP server.

```sh
npx -y @caveman-ai/cloud@rc setup --project PROJECT_ID   # installs cvm, signs in, connects your coding agents
```

`@rc` is the newest release; npm's `latest` tag lags behind it, so install `@rc`. `npm i -g @caveman-ai/cloud@rc` installs cvm by itself. When cvm and the server speak different API versions, the error (and `cvm doctor`) prints the exact install command: the server's release when it reports one, else `@rc`.

```sh
cvm login                 # browser sign-in; one sign-in for cvm and caveman
cvm projects list
cvm traces                # the verbs in one family
cvm traces search --help  # the flags one verb takes
cvm traces tail           # new traces as they arrive (Ctrl-C stops)
cvm sql "SELECT model, count() FROM requests GROUP BY model"
cvm tools list            # every operation this Cloud offers you
cvm mcp                   # Cloud MCP server over stdio
```

- **Sign-in.** `cvm login` signs in with the browser device flow: it prints a code and a link, opens the browser (`--no-browser` or `CAVE_NO_BROWSER=1` to skip) and waits for you to confirm. It stores the credential where `caveman login` does (the macOS Keychain, else `~/.caveman/credentials`), so either CLI's sign-in works for both; `cvm logout` signs both out. `--instance URL` (or `CAVE_API_URL`) signs in to a private install. In CI, set `CAVE_TOKEN` (and `CAVE_API_URL` for a private install).
- **Environment.** A flag wins over the environment, and the environment over the saved login: `CAVE_API_URL`, `CAVE_PROJECT_ID`, `CAVE_TOKEN`. The saved credential is only ever sent to the address it was saved with; another `CAVE_API_URL` needs its own `CAVE_TOKEN`.
- **Projects.** Use `--project UUID`, `CAVE_PROJECT_ID`, `cvm context bind` (writes `.caveman-cloud.json` in the repository) or the saved default.
- **Output.** JSON when piped, readable when on a terminal; `--format json|jsonl|table`. Help follows the same rule: `cvm`, `cvm <family>` and `cvm <family> <verb> --help` are screens on a terminal and JSON when piped, and a mistyped command names the nearest one.
- **Exit codes.** 0 ok · 1 request failed · 2 usage or invalid input (HTTP 400/422) · 3 signed out or forbidden (401/403) · 4 conflict (409) · 5 a comparison or gate failed · 6 timeout, still running or not enough data · 7 rate limited (429).

## Human Code lifecycle

These fixed commands use the same saved human sign-in as `cvm login`. They do
not expose credentials, allocate computers, or grant Code access to agent
connections. Server authorization remains authoritative; an agent connection is
still denied. No arbitrary HTTP paths, request bodies, or headers are accepted.

```sh
cvm human code computers
cvm human code runtimes
cvm human code workspace WORKSPACE_UUID
cvm human code archive WORKSPACE_UUID --yes
cvm human code --help
```

IDs must be canonical hyphenated UUIDs. Archive requires `--yes` (`-y`) even on
a terminal: it terminates sessions and may delete the workspace's computer when
no active workspace uses it. Without confirmation, no request (including login
refresh) is made. These commands accept `--format json|jsonl|table`; `table`
pretty-prints the lifecycle JSON. They use the built-in saved context and its
normal environment overrides, not named operation profiles. Errors omit
upstream response details to avoid disclosing credentials.

## Setup

`cvm setup` connects your coding agents to Caveman Cloud. Each step is safe to run again, and running it again is how you repair a setup.

1. **Install cvm.** Run from a package runner's cache (npx, pnpm dlx, bunx) or a project's `node_modules`, it installs its own version with `npm i -g` (asked on a terminal) unless a cvm as new is already on `PATH`, so your agents start an installed `cvm`. If npm can't (EACCES), setup goes on and the agents run `npx -y @caveman-ai/cloud@VERSION mcp` instead.
2. **Sign in**, unless the saved sign-in or `CAVE_TOKEN` already answers.
3. **Pick the project**: `--project UUID`, else `CAVE_PROJECT_ID`, the repository's binding or the saved default, else your only project. With several, a terminal gets a picker; otherwise setup lists them and exits 2. The project is saved as the default, as `cvm context set` does.
4. **Find the agents**: Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI and OpenCode, by their CLI on `PATH` or their config directory. A terminal gets a list to tick; otherwise every agent found is used. `--agent claude,codex,…` names them.
5. **Install the Caveman Cloud skill**: `~/.claude/skills/caveman-cloud` for Claude Code (`$CLAUDE_CONFIG_DIR/skills` when set), and `~/.agents/skills/caveman-cloud`, which the other six read.
6. **Register the MCP server** `caveman-cloud` (stdio) in each agent's user config:

   | Agent | Config |
   |---|---|
   | Claude Code | `claude mcp add --scope user`, else `~/.claude.json` `mcpServers` |
   | Codex | `~/.codex/config.toml` `[mcp_servers.caveman-cloud]` (`$CODEX_HOME`) |
   | Cursor | `~/.cursor/mcp.json` `mcpServers` |
   | VS Code | `mcp.json` `servers` in your user profile (`~/Library/Application Support/Code/User`, `~/.config/Code/User`, `%APPDATA%\Code\User`) |
   | Windsurf | `~/.config/devin/mcp_config.json` when present, else `~/.codeium/windsurf/mcp_config.json`, `mcpServers` |
   | Gemini CLI | `~/.gemini/settings.json` `mcpServers` |
   | OpenCode | `~/.config/opencode/opencode.json` `mcp` (`type: local`) |

   Terminal agents run `cvm mcp`. Cursor, VS Code and Windsurf don't inherit your shell's `PATH`, so they run `node` and `cvm.mjs` by absolute path.
7. **Ready**: what changed for each agent. On a terminal, setup then offers to start Claude Code or Codex with the task below (`--no-launch` or `--yes` skip the offer).

Setup reports each step to the console's onboarding screen as it runs (best effort). It writes nothing in the repository. In an agent's config it inserts its one entry and leaves the rest of the file byte for byte. It leaves alone a file that isn't plain JSON (one with comments), and a `caveman-cloud` server it didn't add; both are reported with the entry to add yourself (exit 1). It replaces the `caveman cloud mcp-serve` entry an older `caveman` wrote. It replaces only a skill it installed itself (marked by a `.cvm-version` file).

`cvm setup --remove` takes back the skills and the MCP entries it added, restoring each config to what it was when cvm's entry was the only change, and keeps you signed in. Every later `cvm` command refreshes an installed skill when cvm was upgraded. Then open your agent in the repository and ask it: "Set up Caveman Cloud for this repository."

Not on a terminal (an agent's shell, CI, `--format json`), setup asks nothing and prints one JSON object: `ok`, `api`, `project`, `skill`, `agents` (`[{id, skill, mcp, reason}]`, each `changed`, `unchanged` or `failed`), `onboarding_reported` and `next`. `NO_COLOR` turns colour off.

## Deploy an agent

```sh
cvm agent build triage                          # the build: each file, the total and the digest; nothing sent
cvm deploy triage --repo acme/support           # store it and make it live as the deployment "triage"
cvm run triage "Where is order 1042?"           # a session through the deployment, followed until it stops
cvm deployments rollback triage 2               # live again as revision 2's agent version and settings
```

An agent is a folder holding `AGENT.md` (frontmatter and instructions), or one agent file:

```
triage/
  AGENT.md                    frontmatter + instructions
  skills/refunds/SKILL.md     a skill: every file under skills/<name>/ with a SKILL.md
  agents/coder/AGENT.md       a subagent: every file under agents/<name>/ with an AGENT.md
  evals/basic.eval.json       eval files: evals/*.eval.json, *.eval.yaml, *.eval.yml
```

- **`cvm agent build [PATH] [--out DIR]`** writes the agent build output (schema `https://caveman.so/schemas/agent-build.schema.json`): `agent.json` and the files it lists. With no path it builds the folder's `AGENT.md`, else the one agent under `.caveman/agents/` (`<name>.md` or `<name>/AGENT.md`); with several it lists them and exits 2. `agent.json` is derived, with no frontmatter key of its own: `name` (the frontmatter's, else the folder's or file's name), `description`, `model`, `engine` (the loop), `computer` (`none` is the `none` sandbox, anything else `linux`), `tools` (a name is a built-in tool; `{type: custom, name, description, input_schema}` is a tool the caller answers), `connectors` and `budgets` (below). Files are sorted bytewise and nothing in `agent.json` holds a time or a local path, so the same folder always gives the same digest, the SHA-256 of `agent.json`. Without `--out` nothing is written; `--out` takes a new or empty folder. Anything else in the folder is listed as not part of the build.
- **Refused**, each naming the file (exit 2): a symlink, a file that is not UTF-8 text, a file over 2 MiB (`AGENT.md` and `agent.json` 256 KiB), a build over 8 MiB or 1,000 files, and code in a `tools/` folder (code tools need the interpreter sandbox, which this cvm does not build). cvm reads the frontmatter's eight keys itself, with no YAML library: plain and quoted values, `[a, b]` and `{a: b}` on one line or across indented lines, block lists, nested block maps, and a frontmatter that is one JSON object. A block scalar (`|`, `>`), an anchor, alias or tag, a tab indent or a value that continues on the next line is refused with its line; other keys are not read.
- **Connectors in the frontmatter.** `connectors` names the organization's connectors the agent calls, by the name agents write: `connectors: [linear, notion]`, or a map from a name to what it may use: `tools` (1 to 200 tool names; without it, every accepted tool that reads or writes), `as` (`shared`, `user`, `end_user`, or `{read: ..., write: ...}`), `args` (at most 16 arguments the connector's tools always get, each a string, number or `true`/`false`), `approve` and `unpinned` (names from its `tools`). At most 32 connectors, each name lowercase letters, digits and single hyphens, a letter first, at most 32 characters. `budgets: {tools: N}` (100 to 100,000) is the most tokens the agent's tool card may take. `agent.json` gets `connectors` as the map, in the frontmatter's order (a listed name is `{}`), and `budgets`; each is refused with its line when it does not fit, and the build's summary counts the connectors. A build that names none is exactly what it was before. A build holds connector names only, never an address or a secret: `cvm deploy` checks each name against the organization's connectors.
- **`cvm deploy [PATH]`** builds, finds the agent by name and stores the build as its next version (or creates it); an unchanged build stores nothing. It then reads the deployment of that name: its live settings stay and `--repo OWNER/NAME`, `--base-branch`, `--model` and `--budget USD` replace their keys. The deployment's name is `--name`, else the agent's name lowercased with anything outside `a-z`, `0-9` and `-` made `-`. The deploy adds a revision only when the agent version or the settings changed, and says `unchanged` otherwise. A paused deployment stays paused. When the build needs something this Caveman Cloud cannot run yet (skills, subagents, code tools, a sandbox other than `linux`), it is stored, and the output says what a session would be refused for. Each revision records where it came from: `cli`, plus the commit and branch when the agent's folder is in a git checkout (`git rev-parse HEAD` and the checked-out branch; a detached HEAD sends no branch, and no git sends neither). Nothing else about the repository is sent: no remote, path or author. The source is not a setting: the same build and settings are still `unchanged`. An agent that was archived keeps its name, so deploying an agent of that name is refused with `cave_code_agent_archived` (exit 4): name the agent differently in `AGENT.md`. `--dry-run` builds and prints the requests it would make, and sends nothing. The dry run shows the source too.
- **A build that names connectors** first asks Caveman Cloud for the deploy's plan, which changes nothing: whether each connector is there and signed in, what this deploy grants (a manager deploying grants it in the same act) or asks a connector's managers for, how many tools and tokens the agent's tool card takes against its budget, and what to check. The plan is printed between the build line and what went live: `connects` (one line a connector, `+` for one this revision adds, who signed it in, `an app, not a person` for a service, `reads only`, its tool count and effects), `grants`, `tools` and `checks` (each with its fix under it). A connector that is missing, not signed in, or whose tools wait to be accepted is offered at a terminal ("Connect it now? Opens your browser.", "Accept its 23 tools now?") with `cvm connect add`'s and `accept`'s own steps, and the plan is asked for again; a no, or no terminal, prints the refusal and the command that fixes it and exits as a failure does. A connector no catalog template names is added by its address: `cvm connect add <url> --name NAME`. When the deploy would widen what the deployment may use and you manage none of it, it is held: nothing goes live, and the output says `held`, who was asked for each connector, and `cvm connect requests` (exit 0; JSON `status: "held"`). A build that names no connectors sends and prints exactly what it did before. `--dry-run` lists the plan request first.
- **`cvm run DEPLOYMENT TASK...`** starts a session with the deployment's live agent version and settings and prints the agent's messages, a line per tool call, then the status, stop reason and usage. It stops following when the session is idle, waits for an action or has ended. `--no-follow` prints the session and returns. A session that sends nothing for `--timeout` seconds (default 900) ends the wait, not the session; `cvm run --session SESSION_ID` follows it again. Exit 0 when the turn ended, 1 on an error or another stop, 6 when it waits for an action cvm cannot give or the wait ran out, 4 when the deployment is paused or archived.
- **`cvm deployments`** lists deployments (`--archived` adds archived ones); `get NAME`, `revisions NAME` (newest first, each with its trigger, `api`, `cli`, `git` or `rollback to N`, and its commit and branch when known), `rollback NAME REVISION` (adds a revision that copies that one), `pause NAME`, `resume NAME`, `archive NAME --yes` (stops it for good and frees the name; without `--yes` nothing is sent). A deployment is named by its name or its id.

These commands use your sign-in (or `CAVE_TOKEN`) and take `--format json|table`. A refusal prints the API's error code and message and exits by its HTTP status; no other part of a response is printed.

## Connectors

A connector is a server your organization's agents call, by the name they write in `AGENT.md` (`connectors: [linear]`). An admin adds it and signs it in once for the whole team; its managers look after it.

```sh
cvm connect add linear                               # from the catalog: opens the sign-in, then lists its tools to accept
cvm connect add https://tools.acme.dev/mcp --name internal
cvm connect ls                                       # state, who signed each in, tools, what uses it, what waits
cvm connect diff linear                              # what the server changed since the accepted list
cvm connect accept linear                            # accept that list: deploys build from it
cvm connect grant linear --to triage                 # let the deployment triage use it
```

- **`cvm connect add TEMPLATE|URL [--name NAME]`** adds a connector from the catalog by its template's name, or any MCP server by its `https://` address and `--name`, and starts its sign-in. A connector of that name already there is signed in again instead (an address that differs from its own is refused). The sign-in's address is always printed; at a terminal cvm opens it in the browser (not with `--no-browser` or `CAVE_NO_BROWSER`), then reads the connector every 2 seconds for at most 5 minutes until the sign-in lands: connected, and completed later than the sign-in it had before (a token refresh of the old sign-in does not count). Ctrl-C or the 5 minutes stop the wait, not the sign-in: finish it in the browser, then `cvm connect accept NAME`. Then cvm reads the server's tools, lists each by its card line with the ones that act outside named, and accepts them on a yes at the terminal or with `--yes`. A person's sign-in reads only until that person lets agents write with it: at a terminal cvm asks (default no; `--yes` never says yes to it).
- **`cvm connect ls`**: each connector's name, state (`ok`, `paused`, `not connected`, `needs sign-in`), who signed it in (a person or a service, and `reads only` when it may not write in production; `-` while no sign-in has completed), its accepted tools (and, when a newer list waits to be accepted, how many of its tools it adds, changes and removes, or `changed` when Caveman Cloud counts none), the deployments that use it and the requests that wait. Another member's personal connector shows only its name, host and owner.
- **`cvm connect test NAME`** asks the server for its tools once with the shared sign-in: ok with the time and the count, or the problem (exit 1).
- **`cvm connect diff NAME`** reads the server's tools now: what was added, changed (and what about it) and removed since the accepted list, each by its card line; or `no change since` the day it was accepted.
- **`cvm connect accept NAME [--version N] [--effect TOOL=read|write|external ...] [--yes]`** accepts the list read from the server. Without `--version` it reads first and prints the count by effect and every tool that acts outside. It asks at a terminal unless `--yes`; with no terminal and no `--yes` it accepts nothing, exits 2 and prints the command that would.
- **`cvm connect rotate NAME`** signs it in again; the old sign-in works until the new one completes. **`pause NAME [--reason TEXT]`** stops every call to it until **`resume NAME`**. **`allow-writes NAME [--in production,preview,development] [--none]`** says where agents may write with its sign-in (production unless `--in` says more; `--none` reads only); a person's sign-in is marked by the person who signed it in.
- **`cvm connect grant NAME --to DEPLOYMENT [--tools A,B] [--ceiling read|write|external]`** lets a deployment use it (every accepted tool, up to `write`, unless said otherwise); `--revoke` takes the grant away. **`cvm connect request NAME --for DEPLOYMENT`** asks its managers instead; **`cvm connect requests`** lists what waits, and **`cvm connect grant --request ID [--refuse] [--reason TEXT]`** answers, saying what became of a deploy that was held for it (live as which revision, granted for the next deploy, or still waiting on other managers).
- **`cvm connect rm NAME`** removes it after a yes at the terminal, or with `--yes`; its sign-in ends.

A refusal prints the API's code and message and, when the API names one, the command that fixes it (`fix` on a terminal, a `fix` key in JSON). Everything a server sends is printed one line at a time with no control or formatting character, and long sentences are cut. These commands use your sign-in (or `CAVE_TOKEN`) and take `--format json|table`.

## Sandboxes

A sandbox is a computer in Caveman Cloud with nothing of Caveman inside it: you make it, run commands in it from your terminal, put it to sleep and delete it. Sandboxes are made and used with an organization's `code:run` key, which sees only the sandboxes its service account made. `cvm login` cannot make or enter one: cvm then says to set `CAVE_TOKEN` to a key (`cave_code_computer_device_login_forbidden`, exit 3).

```sh
export CAVE_TOKEN=cave_live_...                       # a code:run key (Settings > Service accounts)
cvm sandbox create --name scratch                     # waits until it runs; prints its id
cvm sandbox exec SANDBOX -- uname -a                  # output streamed here; cvm exits with the command's code
echo hi | cvm sandbox exec -i SANDBOX -- cat          # -i sends this terminal's input
cvm sandbox cp ./run.sh SANDBOX:/home/user/           # one file in; SANDBOX:/PATH ./here copies one out
cvm sandbox ls SANDBOX /home/user                     # a folder's files
cvm sandbox port-forward SANDBOX 8080                 # 127.0.0.1:8080 here reaches port 8080 in it, until Ctrl-C
cvm sandbox url SANDBOX 3000                          # a link to port 3000 at its own URL, for a browser
cvm sandbox list                                      # every page of them, newest first
cvm sandbox sleep SANDBOX                             # stops running, keeps its disk
cvm sandbox resume SANDBOX                            # waits until it runs again
cvm sandbox delete SANDBOX --yes                      # its disk too, for good
cvm sandbox snapshot SANDBOX --name clean             # a copy of its disk; waits until it is ready
cvm sandbox snapshots SANDBOX                         # its snapshots, newest first
cvm sandbox restore SANDBOX SNAPSHOT                  # back on the snapshot's disk; waits until restored
cvm sandbox fork SANDBOX SNAPSHOT --name try-2        # a new sandbox from the snapshot; waits until it runs
cvm sandbox snapshot-delete SANDBOX SNAPSHOT --yes    # the snapshot, for good
cvm sandbox status                                    # whether sandboxes work right now
```

- **create** takes `--name`, `--size 4cpu-16gb` (cores and gigabytes, up to what the plan and the installation allow; absent, the installation's default) and `--sleep-after 10m|2h|0`: a sandbox goes to sleep after it has gone unused that long (default 10 minutes; `0` never). Use is what the platform sees: made, resumed, a command started, and every 30 seconds while one runs. A command left running with none open is not use. `--lifetime 2h` deletes it that long after it was made, whatever it is doing (1m to 30d; `get` says when, as `deleted at`). `--network none` gives it no network device: commands, files and ports still reach it through the relay; `internet` is the installation's egress, what it has without the flag. `--no-wait` returns before it runs. The wait is one read the API holds until the sandbox runs (a minute at a time), and a poll only on a Caveman Cloud that does not wait.
- **exec** runs one command in a running sandbox. Its stdout and stderr stay apart, and cvm exits with its exit code. `-e KEY=VALUE` (again for each), `-w DIR` (absolute) and `-u USER` set its environment, folder and user; a sandbox that takes no options refuses them (`cave_code_computer_unsupported`). Ctrl-C sends the command INT, and a second Ctrl-C ends the stream, which ends the command (so does the first, on a sandbox that cannot send a signal). `-t` gives it a terminal the size of yours, which follows yours as it is resized; with `-t -i` your keys, Ctrl-C included, go to the command. A sandbox that sleeps refuses the command (`cave_code_computer_not_running`, exit 4): resume it first. One whose host is restarting is asked again for up to 15 seconds before the command starts, then refused (`cave_code_computer_host_unreachable`, exit 7); a command reading this terminal's input (`-i`) is not asked again. cvm's own failures go to stderr as `failed   CODE: message`.
- **cp** copies one file into a sandbox or out of it, streamed both ways; `SANDBOX:/PATH` names the sandbox's side (absolute), and `-` is this terminal's input or output. A target ending in `/` there, or a folder here, keeps the file's name. A file copied in keeps its permission bits; one copied out is written beside its target and renamed over it once whole, so a failed copy leaves no half file, and stays executable if it was. **ls** lists one folder, by name. `--root` reads and writes as the sandbox's root. A refusal is the file system's own: `cave_code_computer_file_not_found`, `_file_permission`, `_file_exists`, `_file_too_large`, `_file_refused` (exit 1).
- **port-forward** listens on `127.0.0.1` only, on the sandbox's port number unless `LOCAL:PORT` names another (`0:PORT` for any free one), and carries each connection to that port on the sandbox's own loopback, one connection through the relay each; a half close goes through both ways. A connection nothing in the sandbox listens for is closed, with `cave_code_computer_port_refused` on stderr, and the rest go on until Ctrl-C.
- **url** is a port at its own URL, `https://PORT-SANDBOX.DOMAIN`, where the Caveman Cloud serves ports so (`computers.portUrls`; otherwise `cave_sandbox_ports_off`, exit 4, and `port-forward` still works). A port is private: stdout is a link that opens it in a browser for a few minutes, after which the browser keeps it open for that host alone until `--ttl` (1m to 24h, an hour by default); stderr says when each ends. A program sends the token in a `Caveman-Port-Token` header instead (`--format json` shows it; the relay takes the header off). The link and the token are credentials while they last: share them as such. `--public` makes the port open to anyone with the address, and only who made the sandbox may; stdout is then the address. `--private` closes it again.
- **Where commands go.** A command, a file and a port reach the sandbox through the relay that serves `/relay` beside the Cloud API. cvm uses the Cloud address (`CAVE_API_URL`) unless `CAVE_RELAY_URL` or `--relay URL` names another.
- **snapshot** takes a copy of a sandbox's disk (`--name` names it) and waits until it is ready; `--no-wait` returns while it is being taken. A take that fails says why (`cave_snapshot_state`, exit 1, with the snapshot's reason). The snapshot is kept on the host that took it, and only the key whose service account made the sandbox sees it; each key keeps at most 32 at once (`cave_code_computer_limit_snapshots`, exit 4). **snapshots** lists a sandbox's, also once the sandbox is deleted. **restore** puts a running sandbox back on one of its snapshots: its commands end and it starts again on the snapshot's disk, under the same id; an asleep one is refused (`cave_code_computer_asleep`: resume it first), and so is one that moved to another host than the snapshot's (`cave_code_computer_unsupported`: fork instead). **fork** makes a new sandbox from a snapshot, as create does (`--name`, `--size`, `--sleep-after`, `--no-wait`), at the snapshot's size unless `--size` says otherwise. A snapshot not ready is restored and forked never (`cave_code_computer_snapshot_not_ready`, exit 4). **snapshot-delete** asks `--yes`; sandboxes made from the snapshot keep their disks.
- **status** reads whether sandboxes work right now, where the Cloud publishes it (`computers.status.enabled`; otherwise `cave_sandbox_status_off`, exit 4): from the Cloud's canary, which makes, uses and deletes a sandbox every interval (a minute by default), each step's state (`ok`, `degraded`, `down`, `unknown`), when it last passed, and how long it takes. The route is public; the key cvm sends is ignored there.
- **Output.** `--format json|table` as everywhere; JSON is the API's own answer (url's: the sandbox, the port and the token's answer). A refusal prints the API's error code and message (and what to do next when cvm knows) and exits by its HTTP status.
- The installation must offer sandboxes (`computers.api.enabled`). Until it does, cvm says so in one line, `cave_sandboxes_off` (exit 4), whatever it is signed in with: it reads a key's 403 `cave_api_key_route_forbidden`, a create's 405, and a person's list without `computers_api` or get without `bare`.

## An eval in one file

```sh
cvm evals init                                             # writes example.eval.json: three cases, a task, two criteria, a strict gate, a budget
cvm evals validate example.eval.json                       # the schema, and its names against the project
cvm evals run example.eval.json --set-baseline-on-pass     # run it and save the baseline
cvm evals ci evals/*.eval.json                             # in CI: gate a change against that baseline
```

An eval file is JSON (`*.eval.json`; schema `https://caveman.so/schemas/eval-file.schema.json`):

```json
{
  "name": "support-answers",
  "dataset": {"cases": [{"id": "refund", "input": {"question": "How do I get a refund?"}, "expected": "Within 30 days.", "tags": ["billing"]}]},
  "task": {"command": ["node", "answer.mjs"]},
  "criteria": ["Grounded", {"type": "contains", "fragments": ["30 days"]}, {"judge": {"question": "Is the answer polite?", "pass": "Courteous", "fail": "Curt or rude"}}],
  "trials": 3,
  "gate": {"baseline": "saved", "policy": "strict"},
  "budget_usd": 2
}
```

- **name** is the experiment. The same name is the same experiment and the same dataset every time, so runs line up.
- **dataset**: `cases` written in the file, or `{"name": "Support tickets", "version": 3}` for a dataset of the project. A command task runs here on the dataset's rows, so a named dataset with a command task needs a sign-in that may read them (an owner or admin); a CI key reads none. With a task Caveman runs, no row is read here and any sign-in that may run evals will do.
- **task**: `{"command": [...]}` runs here, once per case and trial, directly and not through a shell: the case's input arrives as JSON on stdin, the output is read from stdout (JSON when it parses, else the text), and a non-zero exit or a timeout is a task error. Only a task error is tried again (`retries`, default 2; `timeout_seconds`, default 120; `concurrency`, default 4). `{"recorded": "output"}` grades outputs already in a dataset column. `{"kind": "model" | "prompt" | "http", "config": {...}}` is a target Caveman runs.
- **criteria**: a library criterion by name, a fixed check (`{"type": "contains", ...}`; `cvm criteria catalog` lists the types), or a judge question.
- **gate**: present, a full run is compared on the server with the experiment's saved baseline (or the run id you name). `strict` fails when any criterion got worse on any case, and decides on a handful of cases. `statistical` fails on a drop the numbers support and passes only when they support that too: that takes about 30 cases, and under that it reads need more data (exit 6), which fails a CI job. A run stores the file's policy on the experiment, so the console and the SDKs read the same two runs by the same rule; a gate that names no policy is read by the experiment's stored one (statistical until one is stored), and the result names the policy that decided. Absent, the run is reported and never compared. Two runs compare only on the same cases and criteria: after changing either on purpose, save the new run as the baseline (`cvm evals set_baseline --workbench-id ID --run-id ID`; the refusal prints the command).
- **budget_usd**: the most the run may spend. Required when a project key runs the file, and over one trial.

`cvm evals validate FILE...` exits 2 on an invalid file and every error names its JSON path (`$.criteria[1].fragments`): the schema, and each fixed check's type and options. `--offline` stops there and needs no sign-in; without it the dataset and library criterion names are looked up in the project too.

`cvm evals run FILE...` flags: `--dry-run` runs the task here and sends nothing; `--trials N`; `--first N` or `--sample N --seed S` run some of the cases, and such a partial run is graded but never compared and can never become a baseline (the run says so itself, so the server refuses it too); `--set-baseline-on-pass` saves a passed run as the baseline, and the first run of an experiment, which has nothing to be compared with; `--junit-out PATH` writes a JUnit report with a test case per case and criterion; `--timeout SECONDS` bounds the wait for grading (default 1800).

- **Exit.** 0 passed, or nothing to gate (no gate, no baseline yet, a partial or dry run) · 5 the gate failed · 6 no verdict: more data needed, the runs are not comparable, or not every output could be graded · 2 an invalid file · 1 the run crashed · 4 the server refused the run (a project key's daily budget is held). Several files exit by the worst of them, and nothing runs when one is invalid.
- **Output.** On a terminal, a table: a row per case, a column per criterion (`pass`, `fail` or `error`, and `4/5` over trials), why the failing ones failed with the judge's own reason under it when it gave one, pass rates, the server's verdict sentence with its interval and every criterion that regressed, the baseline and the policy it was read by, cost (what Caveman measured; for a task you ran, its own judging cost, with what your task reported apart), and the console address when `CAVE_CONSOLE_URL` is set. Piped, one JSON object per file. `--format json|table` overrides.

`cvm evals ci FILE...` is the same run for CI: each result also carries the commit, branch and pull request the CI system names, the run keeps them (`scope.commit` on its read, shown in the console), and `--advisory` spares the job the verdict (never an invalid file or a crash). It needs no GitHub: an eval file gates on GitLab CI, Buildkite, Jenkins or a laptop alike. Set `CAVE_TOKEN` to a project key with the eval scope, `CAVE_PROJECT_ID`, and `CAVE_API_URL` for a private install. On GitHub Actions the Caveman action's `files:` input does this. A file a key runs names `budget_usd` (each run's budget is held against the key's limit for the day) and writes its cases in the file, or uses a task Caveman runs. What a key reads of a run holds no judge reason and no error text, so the `Failing:` lines and the JUnit failures name the case and criterion alone; the reasons are on the run in the console.

## Pull request checks from any CI system

```sh
cvm evals ci --suite evals --junit 'reports/junit*.xml' -- npm test
```

With a test command after `--`, `cvm evals ci` wraps a test suite instead of running eval files. It starts a CI run, runs the test command with the run's spend-capped key (`CAVE_API_KEY`, `CAVE_GATEWAY_URL`, `CAVE_CI_RUN_ID`), uploads the JUnit reports, waits for the verdict against the base branch and prints it. The commit, branch, pull request and job come from GitHub Actions, GitLab CI, Buildkite or Jenkins variables, or the checkout; `--sha`, `--ref`, `--base-sha`, `--base-ref`, `--pr`, `--job`, `--repository-id` override them.

- `--advisory` never fails on Caveman's account: not on the verdict, not when Caveman cannot be reached.
- `--max-quality-drop-pp N` and `--max-cost-increase-pct N` add limits of your own. They can only add a failure.
- `--junit-out PATH` writes the verdict as a JUnit report for the CI system's test tab (`-` prints it).
- `--max-usd N` caps the run's key; `--timeout SECONDS` bounds the wait (default 180, 0 does not wait).
- Exit: the test command's own code when it fails; else 0, 5 when the gate failed, 6 when a gating suite had no verdict in time.
- **Credential.** Set `CAVE_TOKEN` to a project API key made for running evals: in the console, New key with "Runs evals from CI" on and a spend limit per day (over the API, scope `eval:ci` alone with `budget_usd` and `budget_period: "daily"`). The key reaches only its own project's datasets, criteria, experiments, runs, verdicts and CI runs, reads no dataset rows or request bodies, and honours its IP allow-list. Every run it starts is given a budget (`--max-usd` here, `scope.budget_usd` on `cvm evals run`); the day's budgets add up to the key's limit, and the next is refused with `cave_key_daily_budget_exceeded` (exit 4) until the next UTC day. A person's session token still works. On GitHub Actions use the Caveman action instead, which needs no secret and writes the check run.
- **Repository.** This check on your test suite gates only for a project with a GitHub repository connected, because whether a run comes from a fork is GitHub's answer. Any other project is refused with `cave_ci_repository_required` (exit 4): on GitLab, Buildkite or Jenkins without that connection, gate on the comparison verdict instead, which needs no repository: eval files, or `cvm evals run --wait` then `cvm evals compare` (exit 5 when the comparison fails).

`cvm evals watch RUN_ID [--timeout SECONDS]` waits for any run's verdict: exit 0 ship, pass or skipped, 5 don't ship or a failed gate, 6 need more data or still running. `cvm evals watch WORKBENCH_ID RUN_ID` is `cvm evals wait`. Operations that start a long run take `--wait` (`cvm evals run --wait`).

Commands come from the Cloud release they ship with: `cvm <family> <verb>` runs the operation `family.verb`. `cvm tools describe <family>.<verb>` prints its input schema.
