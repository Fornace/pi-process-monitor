# Do not schedule agent turns during monitor shutdown

Observed in Torchio session94b7f491 during an authorized safe reload: the
managed telemetry child was intentionally stopped, but its exit callback sent
a displayed PROCESS EXITED message with triggerTurn:true. Pi started a turn
while extensions were being reloaded. The watcher subsequently recovered;
the shutdown notification was not evidence of an unrecovered workload failure.

MonitorRuntime.emit now returns immediately while shuttingDown. Cleanup,
lease release, lifecycle checkpoints, recovery policy and ordinary process
exit notifications are unchanged. This does not keep managed children alive
through reload; it avoids treating intentional teardown as a new agent task.

Verified with a bounded local exercise, no provider calls or live sessions:
one short-lived child still emitted an ordinary exit notification; a separate
sleeping child stopped during shutdown, process absence was verified, state
remained released, and shutdown added zero notifications. Only probe-owned
temporary state/processes were cleaned up. No permanent test code added.
TypeScript typecheck and diff checks pass; runtime.ts remains308lines.

Official evidence reviewed2026-09-05:
https://nodejs.org/api/child_process.html
Scrapling GET20021:05:47UTC, raw /tmp/mantice-monitor-child-process-doc.md.
Node documents exit events for signal termination with null exit code and
the signal name. Installed Nodev26.0.0, package2.0.2, current runtime,
spawn controller, process ownership and session event handlers inspected.
Past30day search_e2aac4b5e9861bf7635d0f5039698313 found current Pi releases
and undated Node docs; no dated change established for this exit behavior.

No npm release, global Pi upgrade, provider replay or forced session reload.
This local path is installed as a shared Pi package; existing extension
instances require their next safe reload to pick up the guard.
