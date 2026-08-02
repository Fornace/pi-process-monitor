---
name: monitor
description: Crash-safe non-blocking watcher for Pi. Own one bounded local process, observe an independently owned remote job with a read-only probe, or tail a log; receive conditional in-session pings without blocking.
user-invokable: true
tested_date: 2026-08-02
tested_with: pi-process-monitor 2.0.0, @earendil-works/pi-coding-agent 0.80.2+
---

# monitor — crash-safe background observation

Use monitor when work may exceed 10 seconds and the user must keep working. It delivers only matching milestones/failures, exit, timeout, and optional heartbeat events.

## Non-negotiable observer/workload split

- **Spawn mode owns a local workload once.** Use `{ "command": "npm test" }`.
- **Poll mode only observes independently owned durable work.** Never put training, conversion, build, test, generation, package installation, mutation, output redirection, backgrounding, or “start if missing” logic in a poll command.
- Prefer structured process/file/SSH/HTTP probes to raw shell.
- Long-running retryable computation belongs in CI, Restate, Trigger.dev, or another workflow engine; monitor observes it.
- Never combine a monitor-launched job with blocking bash retries of the same job.

## Before creating

1. Call `monitor_status`, or use the default `reuse: "return-existing"`.
2. Use narrow identity: PID file, exact log path, workflow/run ID, or remote job ID. Do not broadly match `python`, `swift`, or unrelated process names.
3. Give temporary observers an absolute `expiresAt`.
4. Pick recovery deliberately:
   - spawn: `never`;
   - file/remote structured observer: `safe-auto`;
   - local poll: `confirm`.

## Safe recipes

Remote SSH observer:

```json
{
  "probe": { "type": "ssh", "host": "h100", "command": "tail -n5 /root/train.log; echo ALIVE=$(pgrep -fc axolotl)" },
  "intervalSeconds": 30,
  "label": "h100-qlora",
  "notifyOn": ["adapter.*saved", "error|oom|killed|traceback", "ALIVE=0"],
  "expiresAt": "2026-08-03T00:00:00Z",
  "reuse": "return-existing"
}
```

PID-file observer:

```json
{ "probe": { "type": "process", "pidFile": "/tmp/job.pid" }, "intervalSeconds": 10, "recoveryPolicy": "confirm" }
```

File tail:

```json
{ "logFile": "/tmp/job.log", "notifyOn": ["DONE", "error|oom|killed"], "expiresAt": "2026-08-03T00:00:00Z" }
```

Local owned workload:

```json
{ "command": "npm run build", "label": "build", "recoveryPolicy": "never" }
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
