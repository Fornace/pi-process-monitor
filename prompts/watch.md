Safely start or reuse a non-blocking watcher for the source below.

Before creating it, call `monitor_status`. Use `reuse: "return-existing"` unless I explicitly request replacement or parallel watchers.

Classify the source correctly and set one explicit `source.type`:
- local workload → `spawn`; recovery `never`;
- independent read-only shell observation → `poll`;
- log path → `tail`;
- PID/process identity → `process` with `processBy`;
- structured remote/durable job → `ssh` or `http`.

Put lifecycle and notification settings in `options`. `source.type` is authoritative;
use `null` for irrelevant source fields if a strict provider requires every field.

Never place the actual workload, mutation, output redirection, backgrounding, or “start if missing” logic in a `poll` source command. Prefer a structured source type and narrow PID/run/path identity. Set an absolute `options.expiresAt` for temporary observation.

Source:
$ARGUMENTS

Report the action (`created`, `reused`, `replaced`, or `quarantined`), logical/short watcher ID, mode, recovery policy, expiry, and what will trigger a ping. If quarantined, do not approve it automatically—inspect and explain why. Then continue working; do not block waiting.
