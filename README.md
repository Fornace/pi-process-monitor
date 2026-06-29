# pi-monitor

> Non-blocking background watcher for [pi](https://pi.dev). Start a process, an SSH poll, or a log tail and get **pinged in-session** the moment a milestone hits, a failure occurs, or the process dies — without blocking.

The pi equivalent of Claude Code's `Monitor` tool.

**Why it's better than Claude's naive Monitor:** Claude streams *every* stdout line as an event (= one LLM turn per line: expensive, floods context). `pi-monitor` does **conditional delivery** — only lines matching `notifyOn` (default: milestones + failures), plus process exit, are pushed, and rapid lines are coalesced into one message.

```
┌─────────────────────────────────────────────────────────────┐
│  /monitor ssh h100 'tail -n3 train.log; pgrep -fc axolotl'   │
│   --poll --every 30 --label h100-qlora                       │
│                                                              │
│  ✓ watcher k3n8p2a1x running (poll)                          │
│  → will ping when: adapter.*saved | oom | killed | ALIVE=0   │
│                                                              │
│  (you keep chatting. ~30 min later:)                         │
│  [watcher k3n8p2a1x · h100-qlora] step 100 loss=0.42         │
│  [watcher k3n8p2a1x · h100-qlora] adapter saved → /root/out  │
└─────────────────────────────────────────────────────────────┘
```

## Install

```bash
pi install npm:pi-process-monitor@1.0.0      # global (all projects)
pi install npm:pi-process-monitor@1.0.0 -l   # project-local (.pi/settings.json)
```

Or try it once without installing:

```bash
pi -e npm:pi-process-monitor
```

> **Naming note:** the bare `pi-monitor` name was already taken on npm, so this publishes as `pi-process-monitor`. The original `fornace-pi-monitor@1.0.0` release is deprecated in favor of this one. GitHub: [`Fornace/pi-process-monitor`](https://github.com/Fornace/pi-process-monitor).

Requires the `@earendil-works/pi-coding-agent` peer (already present in any pi install).

## Three sources (pick one)

| mode | tool params | command equivalent | use case |
|------|-------------|--------------------|----------|
| **spawn** | `command` | `/monitor <cmd>` | local long job — spawned once, tailed until exit |
| **poll** | `command` + `intervalSeconds` | `/monitor --poll --every 30 -- <cmd>` | **remote/SSH** — re-run a check on a cadence |
| **file** | `logFile` | `/monitor --file <path>` | tail appended lines of a log |

## Usage (from the agent — tools)

The agent calls these. You can also invoke them via the commands below.

### `monitor` — start a watcher
```json
{
  "command": "ssh h100 'tail -n3 /root/train.log; echo ALIVE=$(pgrep -fc axolotl)'",
  "intervalSeconds": 30,
  "label": "h100-qlora",
  "heartbeatMinutes": 10,
  "notifyOn": ["adapter.*saved", "step (6[0-9]|[1-9][0-9][0-9]) ", "error|oom|killed|traceback", "ALIVE=0"]
}
```
Returns immediately:
```
Watcher k3n8p2a1x running (mode=poll). Will ping when: adapter.*saved | … | ALIVE=0.
```

**Params:**
- `command` — shell command. Spawned once & tailed (`spawn`); if `intervalSeconds` is also set, re-run on that cadence (`poll`).
- `intervalSeconds` — poll cadence in seconds (enables poll mode). Min 2.
- `logFile` — path to a log file to tail (enables file mode). Watch + 5s backstop.
- `notifyOn` — array of case-insensitive regexes. A line matching **any** is pushed. Defaults to milestones + failures.
- `heartbeatMinutes` — emit a status every N minutes even when silent.
- `label` — human label.
- `coalesceSeconds` (default 2), `maxLines` (default 20), `cwd` (default current).

### `monitor_status` — list watchers
```
- k3n8p2a1x · h100-qlora [poll] alive=true events=4 last=2026-06-29T12:30:01Z watching: adapter.*saved | …
```

### `monitor_kill` — stop a watcher
```json
{ "id": "k3n8p2a1x" }
```
Spawn mode SIGTERMs then SIGKILLs the child after 3s.

## Usage (human — slash commands, with autocomplete)

```bash
/monitor ssh h100 'tail -n3 train.log; pgrep -fc axolotl'   # spawn watcher
/monitor --poll --every 30 -- ssh h100 'tail -n3 train.log' # poll every 30s
/monitor --file /var/log/train.log                          # tail a log
/monitors                                                   # list
/monitor-kill <TAB>                                         # autocomplete live ids
```

`/monitor-kill` autocompletes the live watcher ids, so you never have to copy them.

## Default `notifyOn` (case-insensitive regex)

**Milestones:** `saved`, `checkpoint`, `complete(d)`, `done`, `finished`, `ready`, `started`, `listening`, `success`, `ok`, `✓`, `✔`
**Failures:** `error`, `fail(ed)`, `oom`, `out of memory`, `killed`, `traceback`, `exception`, `fatal`, `abort`, `panic`, `segfault`

Override per-call with `notifyOn: [...]`.

## How the ping works (don't fight it)

- **Idle agent** → the matching message triggers a fresh turn (agent wakes, reads the pushed lines, acts).
- **Mid-stream agent** → the message queues as a **steer**, delivered after the current turn's tool calls, before the next LLM call. Your in-progress work is not lost.
- **Rapid matching lines** are coalesced into one message so a chatty log doesn't flood context.

This is built on pi's `pi.sendMessage({…}, { triggerTurn: true, deliverAs: "steer" })` — it wakes an idle agent without you blocking, and never interrupts an in-flight turn destructively.

## Restart-resume

**Poll & file watchers survive a pi restart** within the same session: they're persisted via `pi.appendEntry` and re-attach on the next `session_start`, announcing themselves. So if your laptop sleeps during an H100 training run, resuming the session re-attaches the watcher and you keep getting pings.

Spawn-mode children can't survive (they're children of the pi process and are killed on shutdown) — that's inherent, not a bug.

## What registers

| kind | name | purpose |
|------|------|---------|
| tool | `monitor` | start a watcher (returns `{watcherId}`) |
| tool | `monitor_status` | list watchers |
| tool | `monitor_kill` | stop one |
| command | `/monitor` | start (human; supports `--poll`/`--every`/`--file`) |
| command | `/monitors` | list |
| command | `/monitor-kill` | stop (autocompletes ids) |
| skill | `monitor` | auto-invoked when the agent detects a long-running job |
| prompt | `/watch` | quick start a watcher from a source string |

## Pitfalls

- **Don't** wrap a `monitor` call in a blocking `bash` wait — that defeats the point. `monitor` returns immediately; trust the ping.
- For **poll mode**, the `command` must be *idempotent and fast* (a tail + a process check). The actual long job runs separately on the remote; the poll just checks it.
- Always include a **death signal** in `notifyOn` for poll/file mode (e.g. `ALIVE=0`), otherwise a silently-dead remote job won't ping you.
- For chatty logs, pass a **tight** `notifyOn` to avoid coalescer churn.

## Development

```bash
git clone https://github.com/Fornace/pi-process-monitor
cd pi-monitor
npm install      # peer deps
npm test         # runtime smoke test
npm run typecheck
```

## License

MIT © Francesco Frapporti
