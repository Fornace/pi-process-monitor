# Changelog

All notable changes to `pi-process-monitor` are documented here.

## [2.0.0] — unreleased

### Crash-safe identity and recovery

- Added stable logical watcher UUIDs, canonical SHA-256 source fingerprints, monotonic lifecycle revisions, absolute expiry, and active-branch-only state reduction.
- Added deterministic migration for legacy `monitor-watcher` history without writing the legacy shape.
- Recovery now claims the same logical watcher instead of replaying a new creation.
- Added atomic cross-process leases with runtime/owner epochs, host boot ID, PID, process-start validation, renewal, clean release, stale archive, and fail-closed corruption handling.
- Added abnormal-restart quarantine and session crash-loop fuses.
- Added exact `return-existing`, explicit `replace`, and intentional keyed `parallel` reuse semantics.

### Bounded observation and ownership

- Added structured process/file/SSH/HTTP probes.
- Local raw-shell polls default to confirmation and workload-like/mutating commands quarantine before launch.
- Poll ticks now have no overlap, per-tick timeout, bounded stdout/stderr, exponential backoff with jitter, failure suspension, and host-pressure delay/quarantine.
- Spawn and poll children run in dedicated POSIX process groups with TERM/KILL escalation and verified cleanup.
- Added process receipts: logical ID, owner epoch, argv hash/display, cwd, PID, PGID, parent PID, boot ID, process start, exit, signals, truncation, and cleanup proof.

### Lifecycle GC and interfaces

- Added versioned checkpoints with bounded terminal retention and external lease cleanup.
- Added `monitor_inspect`, `monitor_recover`, `monitor_gc`, and confirmed `monitor_kill_all`.
- Status and startup summaries now expose lifecycle/ownership without notification storms.
- Split the extension into single-responsibility modules, all below 400 lines.
- Rewrote README, skill, `/watch`, migration, and grounding receipts to match runtime behavior.

### Verification

- Added active-branch, state transition, checkpoint, malformed/future schema, deterministic legacy migration, exact reuse, recovery identity, concurrent lease owner, stale PID validation, poll timeout/backoff/caps, process-tree teardown, incident replay, 100-cycle reduction, no-UI, clock, corrupt lease, pressure-unavailable, and effective-version mismatch tests.

### Breaking

- Local poll recovery no longer silently auto-resumes. It defaults to `confirm` and unsafe/ambiguous shell polling is quarantined.
- The package therefore requires a major release rather than a compatible minor.

## [1.3.0] — 2026-07-25

### Fixed

- Idempotent watcher teardown and in-process deduplication.
- Persisted stop tombstones and clean-shutdown resource release.

## [1.2.0] — 2026-07-13

- Added relative `timeoutSeconds` watcher auto-stop.

## [1.1.0] — 2026-06-29

- Added gallery preview metadata.

## [1.0.0] — 2026-06-29

- Initial `pi-process-monitor` release.
