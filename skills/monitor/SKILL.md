---
name: monitor
description: Crash-safe non-blocking watcher for Pi. Own one bounded local process, observe an independently owned remote job with a read-only probe, or tail a log; receive conditional in-session pings without blocking.
user-invokable: true
tested_date: 2026-08-13
tested_with: pi-process-monitor 2.0.2, @earendil-works/pi-coding-agent 0.80.2+
---

# monitor: crash-safe background observation

Use monitor when work may exceed 10 seconds and the user must keep working. It delivers only matching milestones/failures, exit, timeout, and optional heartbeat events.

## Public input contract

Use one required `source` object and select the mode with `source.type`:

- `spawn`: run one owned local workload once. Requires `source.command`.
- `poll`: repeat one fast read-only shell observation. Requires `source.command`; cadence is `source.intervalSeconds`.
- `tail`: follow appended lines. Requires `source.path`.
- `process`: observe a process. Set `source.processBy` to `pidFile` or `match`, then provide that selected field.
- `file`: structured file observation. Requires `source.path`.
- `ssh`: structured remote observation. Requires `source.host` and `source.command`.
- `http`: structured endpoint observation. Requires `source.url`.

`source.type` is authoritative. Some strict OpenAI-compatible providers emit every declared source field. Set irrelevant fields to `null`; if they arrive non-null, monitor ignores and reports them rather than confusing them with another source. Put lifecycle and notification settings inside `options`, or set `options` to `null`.

Legacy top-level `command`, `logFile`, and `probe` calls remain accepted through argument preparation. New calls should use the discriminated `source` object.

## Non-negotiable observer/workload split

- **Spawn mode owns a local workload once.** Use `{ "source": { "type": "spawn", "command": "npm test" }, "options": null }`.
- **Poll mode only observes independently owned durable work.** Never put training, conversion, build, test, generation, package installation, mutation, output redirection, backgrounding, or “start if missing” logic in a poll command.
- Prefer structured `process`, `file`, `ssh`, and `http` sources to raw shell polling.
- If the user asks you to stop using monitor, stop immediately and continue with direct execution. Do not retry the tool with alternative argument shapes.
- Long-running retryable computation belongs in CI, Restate, Trigger.dev, or another workflow engine; monitor observes it.
- Never combine a monitor-launched job with blocking bash retries of the same job.

## Before creating

1. Call `monitor_status`, or use `options.reuse: "return-existing"` (the default).
2. Use narrow identity: PID file, exact log path, workflow/run ID, or remote job ID. Do not broadly match `python`, `swift`, or unrelated process names.
3. Give temporary observers an absolute `options.expiresAt`.
4. Set exactly one explicit `source.type`. Do not infer spawn versus poll from `intervalSeconds`.
5. Pick recovery deliberately:
   - spawn: `never`;
   - file/remote structured observer: `safe-auto`;
   - local poll/process: `confirm`.
6. After any monitor validation error, read the named field and example. Do not repeat an unchanged payload.

## Safe recipes

Remote SSH observer:

```json
{
  "source": {
    "type": "ssh",
    "host": "h100",
    "command": "tail -n5 /root/train.log; echo ALIVE=$(pgrep -fc axolotl)",
    "intervalSeconds": 30
  },
  "options": {
    "label": "h100-qlora",
    "notifyOn": ["adapter.*saved", "error|oom|killed|traceback", "ALIVE=0"],
    "expiresAt": "2026-08-03T00:00:00Z",
    "reuse": "return-existing"
  }
}
```

PID-file observer:

```json
{
  "source": { "type": "process", "processBy": "pidFile", "pidFile": "/tmp/job.pid", "intervalSeconds": 10 },
  "options": { "recoveryPolicy": "confirm" }
}
```

File tail:

```json
{
  "source": { "type": "tail", "path": "/tmp/job.log" },
  "options": { "notifyOn": ["DONE", "error|oom|killed"], "expiresAt": "2026-08-03T00:00:00Z" }
}
```

Local owned workload:

```json
{
  "source": { "type": "spawn", "command": "npm run build" },
  "options": { "label": "build", "recoveryPolicy": "never" }
}
```

Read-only local poll (still supported):

```json
{
  "source": { "type": "poll", "command": "ps -p 123 -o pid=,stat=,etime=,command=", "intervalSeconds": 10 },
  "options": { "recoveryPolicy": "confirm", "safetyClass": "observer" }
}
```

## Lifecycle and recovery

- `monitor_status`: check identity, state, owner, expiry, last tick, and failures.
- `monitor_inspect { id }`: inspect lease and process receipt.
- `monitor_kill { id }`: stop only the verified extension-owned group.
- `monitor_recover`: list/approve/reject quarantined watchers.
- `monitor_gc`: dry-run by default; apply checkpoint/external cleanup explicitly.
- `monitor_kill_all { confirm: true }`: current-session owned groups only.

Poll ticks never overlap and have timeout, bounded output, backoff, jitter, failure suspension, and process-group cleanup. Recovery keeps the logical ID and acquires one atomic owner lease. Repeated abnormal host restarts quarantine instead of replaying.

A timeout or quarantine means **stop and diagnose**. Do not immediately launch an identical watcher. Never approve an abnormal-restart quarantine without inspecting it first.

## Ping behavior

- Idle agent: matching event wakes a turn.
- Busy agent: event queues as a safe steer.
- Rapid matches coalesce; output is bounded.

Trust the ping. Do not wrap monitor in a blocking wait.
