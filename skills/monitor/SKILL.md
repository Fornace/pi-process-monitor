---
name: monitor
description: Non-blocking background watcher for pi. Start a long-running process (training, dev server, CI), poll a remote SSH command, or tail a log file, and get pinged in-session the moment a milestone hits, a failure occurs, or the process dies — without blocking the session. Use when a job may run minutes-to-hours and you need to keep working while it runs.
user-invokable: true
tested_date: 2026-06-29
tested_with: pi-process-monitor 1.0.0, @earendil-works/pi-coding-agent (peer)
---

# monitor — non-blocking background watcher

The pi equivalent of Claude Code's `Monitor` tool. The headline difference:
**conditional delivery** — only lines matching `notifyOn` (default: milestones +
failures) plus process-exit get pushed to the session, instead of one LLM turn
per stdout line. Keeps context lean and the session unblocked.

## When to use this

Any task that could plausibly run **longer than a few seconds** AND you want to
keep chatting / doing other work instead of blocking:

- **ML training** (axolotl, vLLM, accelerate, torchrun) — ping on adapter-saved / OOM / step walls
- **Remote SSH jobs** — poll a box every N seconds (`ssh h100 'tail; pgrep'`)
- **Dev servers / builds** — ping on "listening", crash, or first error
- **CI / long tests / migrations**
- **Log tails** — watch a file for appended milestone/error lines

If it's under ~10s, just run it inline (bash). If it might run minutes-to-hours,
use `monitor`.

## Three sources (pick one)

| mode | tool params | command equivalent | use case |
|------|-------------|--------------------|----------|
| `spawn` | `command` | `/monitor <cmd>` | local long job — spawned once, tailed until exit |
| `poll` | `command` + `intervalSeconds` | `/monitor --poll --every 30 -- <cmd>` | **remote/SSH** — re-run a check on a cadence |
| `file` | `logFile` | `/monitor --file <path>` | tail appended lines of a log |

## The default `notifyOn` (regex, case-insensitive)

milestones: `saved`, `checkpoint`, `complete(d)`, `done`, `finished`, `ready`,
`started`, `listening`, `success`, `ok`, `✓`, `✔`
failures: `error`, `fail(ed)`, `oom`, `out of memory`, `killed`, `traceback`,
`exception`, `fatal`, `abort`, `panic`, `segfault`

Override per-call with `notifyOn: [...]` (regexes). Always include a
death/exit signal for poll mode, e.g. an `ALIVE=0` sentinel.

## Recipes

### ML training on a remote H100 (the canonical case)
```json
{ "command": "ssh h100 'tail -n3 /root/train.log; echo ALIVE=$(pgrep -fc axolotl)'",
  "intervalSeconds": 30, "label": "h100-qlora", "heartbeatMinutes": 10,
  "notifyOn": ["adapter.*saved", "step (6[0-9]|[1-9][0-9][0-9]) ", "error|oom|killed|traceback", "ALIVE=0"] }
```
Returns at once (`Watcher <id> running`). You keep working. The session is
pinged when the adapter saves, when step 60+ lands, on OOM, or when the process
dies. Heartbeat every 10 min even if silent.

### Local dev server (spawn)
```json
{ "command": "cd app && npm run dev", "label": "dev",
  "notifyOn": ["listening|ready|started", "error|EADDR|crash"] }
```

### Tail an existing log
```json
{ "logFile": "/var/log/train.log", "notifyOn": ["loss=", "OutOfMemory", "Killed"] }
```

## Lifecycle
- `monitor_status` / `/monitors` — list watchers (id, mode, events, last ping)
- `monitor_kill {id}` / `/monitor-kill <id>` — stop one (`/monitor-kill <TAB>`
  autocompletes live ids; spawn mode SIGTERMs then SIGKILLs the child)
- **Restart-resume**: poll & file watchers survive a pi restart within the same
  session (persisted via appendEntry) and announce themselves on re-attach.
  spawn-mode children die with the session (unavoidable — the child is a child
  of the pi process).

## How the ping works (don't fight it)
- Idle agent → the matching message triggers a fresh turn (agent wakes, reads the
  pushed lines, acts).
- Mid-stream agent → the message queues as a steer, delivered after the current
  turn's tool calls, before the next LLM call. Your in-progress work is not lost.
- Rapid matching lines are **coalesced** into one message (default 2s window,
  max 20 lines) so a chatty log doesn't flood context.

## Pitfalls
- **Don't** wrap a `monitor` call in a blocking `bash` wait — that defeats the
  point. `monitor` returns immediately; trust the ping.
- For poll mode, your `command` must be **idempotent and fast** (a tail + a
  process check). Don't put the actual long job in the poll command — the long
  job runs separately on the remote; the poll just *checks* it.
- Always include a death signal in `notifyOn` for poll/file mode (e.g.
  `ALIVE=0`), otherwise a silently-dead remote job won't ping you.
- Default `notifyOn` is broad. For chatty logs, pass a tight `notifyOn` to avoid
  coalescer churn.
