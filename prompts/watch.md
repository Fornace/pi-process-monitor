Safely start or reuse a non-blocking watcher for the source below.

Before creating it, call `monitor_status`. Use `reuse: "return-existing"` unless I explicitly request replacement or parallel watchers.

Classify the source correctly:
- local workload → spawn once; recovery `never`;
- independent remote/durable job → read-only poll or structured SSH/HTTP/process probe;
- log path → file tail.

Never place the actual workload, mutation, output redirection, backgrounding, or “start if missing” logic in a poll command. Prefer a structured probe and narrow PID/run/path identity. Set an absolute `expiresAt` for temporary observation.

Source:
$ARGUMENTS

Report the action (`created`, `reused`, `replaced`, or `quarantined`), logical/short watcher ID, mode, recovery policy, expiry, and what will trigger a ping. If quarantined, do not approve it automatically—inspect and explain why. Then continue working; do not block waiting.
