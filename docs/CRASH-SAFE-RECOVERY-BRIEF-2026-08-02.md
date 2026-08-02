# Engineering brief: crash-safe monitor identity, recovery, and lifecycle GC

**Repository:** `pi-process-monitor`  
**Prepared:** 2026-08-02  
**Target:** next major/minor release after 1.3.0  
**Priority:** P0 reliability / host safety  
**Scope:** extension code, persisted state protocol, tests, skill/prompt guidance, diagnostics, and migration

## 1. Executive summary

`pi-process-monitor` must remain a non-blocking observer that can survive normal Pi restarts without becoming a source of duplicated work, stale polling, or reboot loops.

An incident on macOS 27.0 (`26A5388g`) exposed a dangerous interaction between restart recovery and persisted watcher history. A Pi session repeatedly resumed after watchdog kernel panics. Its active foreground task was a full Swift regression, while old poll watchers for Qwen archive/conversion state were repeatedly reconstructed. The session transcript accumulated duplicate resumed watcher records. Panic snapshots showed many Python processes in one jetsam coalition, several with roughly 13 GB resident memory, followed by:

```text
watchdog timeout: no checkins from watchdogd in 90–94 seconds
Boot faults: wdog,reset_in_1
```

The evidence proves a recovery-amplification failure. It does **not** prove that every large Python process was directly launched by a specific watcher command, so the implementation must add causal process receipts rather than rely on process-name inference.

The fix must not be merely a peak-memory limiter. Required changes are:

1. durable logical watcher identity;
2. lease-based, single-owner recovery;
3. branch-aware state reduction;
4. exact reuse instead of append-on-resume;
5. lifecycle garbage collection and compaction;
6. strict observer/workload separation for poll mode;
7. process-tree ownership and receipts;
8. bounded polling and host-pressure circuit breakers;
9. explicit recovery policies and user-visible quarantine;
10. stronger skill guidance so agents do not misuse poll watchers as job launchers.

The intended outcome is **at-most-one live local owner per logical watcher**, with recovery that is conservative, inspectable, and reversible.

---

## 2. Incident reconstruction

### 2.1 Session and workload

Affected Pi session:

```text
019fbca6-5020-72b6-acb3-d2da1888472c
```

Working repository:

```text
/Users/ffrappo/works/repos/mage-flow-metal41-unisvq2
```

Immediately before the reboot loop, the session had committed multimodal Qwen processor changes and was repeatedly trying to capture:

```bash
swift test --disable-sandbox
```

Persisted poll watchers from earlier work also targeted:

```text
/tmp/qwen-int4-language
/tmp/qwen-vision-bf16-language
```

On each recovery, transcript entries showed several resumed polling definitions, including duplicate definitions for the same source command.

### 2.2 Confirmed host failure

Eight panic reports occurred between 09:14 and 10:20 on 2026-08-02. Every report was a watchdog panic. Reset-counter receipts recorded `wdog,reset_in_1`.

Panic snapshots contained numerous Python processes in one coalition. Several reported about 13.08 GB resident memory, with many additional multi-gigabyte Python processes. Swift/XCTest and Metal compiler activity was also present.

### 2.3 What is known versus inferred

**Known:**

- Pi restored watcher state after restart.
- duplicate resumed watcher records appeared in the transcript;
- the session repeatedly relaunched the full regression;
- many high-memory Python processes existed at panic time;
- the host watchdog reset the machine;
- current persistence is append-only and reconstructed from historical custom entries.

**Strong inference:** restart recovery amplified local activity and failed to converge to one logical watcher owner.

**Not yet proven:** the exact argv and ancestry of every high-memory Python process. The next implementation must make this provable through spawn receipts, process-group IDs, owner epochs, and exit records.

---

## 3. Current design weaknesses

Current implementation is concentrated in `extensions/monitor.ts`. Version 1.3.0 already improves teardown, tombstones, and in-process deduplication, but important gaps remain.

### 3.1 Historical entries are treated as current state

Recovery scans `ctx.sessionManager.getEntries()` and reduces entries by a key derived primarily from `command` or `logFile`. Problems:

- `getEntries()` includes the entire session tree, not only the active branch;
- logically equivalent commands with whitespace, paths, shell wrappers, or reordered options can produce different keys;
- unrelated watchers with identical commands can collapse incorrectly;
- a restart creates a new watcher ID instead of retaining a stable logical ID;
- `launch()` appends a new start record during recovery, so recovery mutates history merely by observing it;
- repeated crash/recovery cycles grow the journal indefinitely.

### 3.2 No ownership lease

A persisted watcher record says “active,” but does not say which Pi runtime owns it, whether that owner is still alive, or whether another runtime already recovered it. Two Pi processes can attach to the same session and both restore the same watcher.

### 3.3 In-process dedupe is insufficient

The `watchers` map prevents duplicates only inside one extension instance. It cannot protect against:

- multiple Pi processes opening the same session;
- stale extension instances during reload/replacement mistakes;
- a crash before a stop tombstone is written;
- concurrent session starts;
- duplicated package loading.

### 3.4 Poll commands are unrestricted shell programs

Poll mode is intended for cheap, idempotent observation, but accepts arbitrary shell. There is no distinction between:

- a safe status probe (`tail`, `stat`, `pgrep`, remote SSH check);
- a local workload (`python train.py`, conversion, build, test);
- a compound command that starts work if an artifact is absent.

A poll interval can therefore become an accidental scheduler.

### 3.5 Timeout semantics reset on recovery

Persisted `timeoutSeconds` is relative. Recovery starts a fresh timeout instead of preserving an absolute deadline. A watcher intended to expire after one hour can live forever through repeated restarts.

### 3.6 Weak process ownership

Spawned commands are not assigned a dedicated process group/session. Stopping the shell PID may leave grandchildren alive. Poll children are killed only with `SIGTERM`, with no process-tree verification or escalation receipt.

### 3.7 No GC or state compaction

Start records and tombstones remain forever. There is no checkpoint/snapshot record, retention policy, stale-source expiry, or migration cleanup. Long sessions become increasingly expensive and ambiguous to reconstruct.

### 3.8 No host-pressure feedback

The monitor does not inspect memory pressure, swap, load, process count, or recent panic/reset signals. A monitor should not become a general resource manager, but it should fail closed when its own recovery or polling would add work to an unstable host.

---

## 4. Design principles

1. **Observe, do not schedule.** Poll mode checks state; spawn mode owns a workload.
2. **Logical identity is stable.** Runtime IDs and logical watcher IDs are different concepts.
3. **Recovery is a claim, not a replay.** A runtime must acquire ownership before starting resources.
4. **At-most-one local owner.** Duplicate execution is more dangerous than a delayed notification.
5. **Conservative after abnormal restart.** Auto-resume remote/file observers; quarantine ambiguous local polling.
6. **State is reduced from the active branch.** Abandoned branch records must not resurrect.
7. **Deadlines are absolute.** Restart never extends TTL unintentionally.
8. **Every child is attributable.** Record argv hash, PID, PGID, start time, owner, and exit.
9. **GC is part of correctness.** Append-only history needs snapshots and bounded retention.
10. **Safety controls preserve functionality.** Remote training monitoring and log tails should remain seamless.

---

## 5. Proposed watcher state model

Replace ad-hoc start/tombstone records with a versioned event protocol.

```ts
type WatcherStateEvent = {
  schemaVersion: 2;
  logicalId: string;          // stable across recovery
  revision: number;           // monotonic per logical watcher
  event: "created" | "claimed" | "heartbeat" | "released" |
         "stopped" | "expired" | "quarantined" | "checkpoint";
  mode: "spawn" | "poll" | "file";
  sourceFingerprint: string;
  owner?: {
    runtimeId: string;        // random per extension runtime
    pid: number;
    bootId: string;           // host boot-session identifier where available
    leaseUntil: string;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  recoveryPolicy: "never" | "confirm" | "safe-auto";
  config?: PersistedWatcherConfig;
  reason?: string;
};
```

### 5.1 Identity

- `logicalId` is generated once at creation and reused forever.
- UI/runtime handles may remain short IDs, but must map to `logicalId`.
- `sourceFingerprint` is a SHA-256 hash of canonical structured configuration, not raw command alone.
- Canonical input includes mode, normalized cwd, command/log path, interval, remote/local classification, and recovery policy.
- Do not merge two independently created watchers solely because commands match. Reuse is explicit through `reuseKey` or a matching active logical watcher.

### 5.2 Revision and reduction

- Each state transition increments `revision`.
- Reduce only `ctx.sessionManager.getBranch()` or the active path equivalent.
- Reject malformed records and non-monotonic transitions.
- Latest valid revision per `logicalId` wins.
- A `checkpoint` contains the reduced active set and a high-water entry ID; older events become ignorable.

---

## 6. Lease-based single-owner recovery

### 6.1 Local lease registry

Session entries alone cannot provide atomic cross-process exclusion. Add a local lease registry under a runtime directory such as:

```text
~/.pi/agent/state/pi-process-monitor/<session-id>/<logical-id>.lease
```

Acquire with an atomic primitive (`mkdir`, `open(O_CREAT|O_EXCL)`, or atomic rename). The lease contains runtime ID, PID, boot ID, acquisition time, and expiry.

### 6.2 Claim algorithm

On `session_start`:

1. reduce active-branch watcher state;
2. discard stopped/expired records;
3. evaluate recovery policy;
4. try to atomically acquire the lease;
5. if lease belongs to a live PID in the same boot, reuse/skip—never duplicate;
6. if stale, archive it as orphaned and claim with a new owner epoch;
7. append one `claimed` event only after successful acquisition;
8. start resources without appending a synthetic `created` event;
9. renew lease on a low-frequency heartbeat;
10. release lease on clean shutdown without marking user intent as stopped.

### 6.3 Crash-loop fuse

Track abnormal recoveries per logical watcher and session:

- 2 abnormal recoveries in 10 minutes: quarantine local poll watchers;
- 3 abnormal recoveries in 30 minutes: disable all automatic local recovery for that session;
- remote SSH polls and file tails may continue only if classified safe and host pressure is normal;
- show one clear notification with `/monitor-recover` choices.

A clean shutdown resets or decays the fuse.

---

## 7. Recovery policies

Add an explicit `recoveryPolicy` parameter.

### `never`

Do not restore after Pi exits. Recommended for local process-adjacent checks and sensitive jobs.

### `confirm`

Restore only after user confirmation in TUI/RPC. In non-interactive modes, remain quarantined.

### `safe-auto`

Auto-restore only if the watcher passes safe-observer classification, owns a valid lease, has not expired, and is not in a crash loop.

Defaults:

| Mode/source | Default |
|---|---|
| file tail | `safe-auto` |
| remote SSH/API poll | `safe-auto` |
| local poll | `confirm` |
| spawn | `never` (unchanged: child cannot survive) |

Preserve existing remote monitoring functionality by making the common SSH-tail use case auto-resume safely.

---

## 8. Observer/workload separation

### 8.1 Structured probe types

Long term, prefer structured poll sources over arbitrary shell:

```ts
probe: { type: "process", pidFile?: string, match?: string }
probe: { type: "file", path: string, tailLines: number }
probe: { type: "ssh", host: string, command: string }
probe: { type: "http", url: string, method: "GET" | "HEAD" }
```

Keep raw shell polling for compatibility, but classify it as `unsafe-shell` unless explicitly acknowledged.

### 8.2 Static safety classification

A deterministic classifier should flag local poll commands containing likely workload launchers or mutation operators, including Python/Swift test/build/train/convert invocations, output redirection, package managers, backgrounding, or commands chained to start work.

This classifier is a guardrail, not a security sandbox. Avoid giant brittle regex policy. Use a small exact-token parser for shell operators and executable basename, with an optional fast-model semantic classifier only in agent guidance—not in the extension’s critical path.

### 8.3 Runtime constraints per tick

Every poll tick must have:

- a per-tick timeout (`pollTimeoutSeconds`, default below interval);
- no overlap;
- stdout/stderr byte cap;
- dedicated process group;
- TERM then KILL escalation;
- minimum interval;
- consecutive-failure backoff with jitter;
- suspension after repeated timeouts.

A poll command that outlives its interval is unhealthy even if overlap prevention skips ticks.

---

## 9. Accurate reuse semantics

Add explicit reuse behavior:

```ts
reuse: "return-existing" | "replace" | "parallel"
reuseKey?: string
```

Default `return-existing` when the same tool call is repeated in one session and matches an active fingerprint. Return the existing watcher metadata instead of creating another watcher or persistence event.

- `replace`: stop/release the old logical watcher, then create a new revision/config.
- `parallel`: intentionally create another logical watcher; require distinct `reuseKey` or explicit confirmation for local polls.

The returned tool result must state whether it **created**, **reused**, **replaced**, or **quarantined** a watcher.

---

## 10. Garbage collection and compaction

### 10.1 In-memory GC

Ensure every terminal path clears:

- timers and intervals;
- coalescers;
- `fs.watch` handles;
- child listeners;
- process-group escalation timers;
- lease heartbeat;
- maps and retained closures.

Use one idempotent lifecycle controller rather than wrappers that repeatedly decorate `w.stop`.

### 10.2 Durable GC

Implement periodic checkpointing:

- append a `checkpoint` after N state events or at clean shutdown;
- checkpoint contains only reduced nonterminal watchers and recent terminal summaries;
- recovery starts from the latest checkpoint on the active branch;
- ignore earlier watcher events;
- retain terminal records for a bounded period, e.g. seven days or 100 records;
- provide `/monitor-gc` and `monitor_gc` dry-run/apply interfaces.

Pi session JSONL cannot be rewritten casually, so “GC” means logical compaction through checkpoints plus cleanup of external lease/runtime files. Physical session compaction can remain Pi-owned.

### 10.3 External state cleanup

At startup and on `/monitor-gc`:

- delete expired leases whose PID is dead or boot ID differs;
- remove empty session state directories;
- archive recent orphan receipts for diagnostics;
- never kill an unverified PID merely because a stale lease names it—validate boot ID and process start time.

---

## 11. Host-pressure circuit breaker

This is secondary defense, not the primary identity fix.

Before recovering or starting a local poll tick, sample cheap host signals:

- available memory / memory-pressure status;
- swap and compressor trend where supported;
- load average normalized by CPU count;
- count of this monitor’s owned children;
- recent abnormal recovery count.

Actions:

1. **normal:** run;
2. **elevated:** delay with exponential backoff and notify once;
3. **critical:** quarantine watcher and release lease;
4. **repeated critical:** trip session fuse.

Do not globally kill unrelated workloads. Only stop process groups provably owned by this extension.

Make thresholds configurable and platform-adapted. If telemetry is unavailable, identity/lease protections still apply.

---

## 12. Process ownership and forensic receipts

For every spawned process, record:

- logical watcher ID and owner epoch;
- full command hash and safely truncated display command;
- cwd;
- PID, PGID/session ID;
- parent Pi PID;
- host boot ID and process start time;
- start timestamp;
- exit code/signal;
- whether TERM/KILL was sent;
- peak RSS if cheaply available;
- stdout/stderr truncation counts.

Expose this in `monitor_status` and a new `monitor_inspect { id }` tool. This turns future incident analysis from correlation into causation.

Spawn local commands detached into a dedicated process group where Node/macOS semantics allow. Stop the entire owned group, not only the shell. Verify group exit before declaring cleanup complete.

---

## 13. User and agent interfaces

### 13.1 Tool additions

Extend `monitor` parameters with:

```text
recoveryPolicy
reuse
reuseKey
pollTimeoutSeconds
maxConsecutiveFailures
backoffMaxSeconds
safetyClass: auto | observer | unsafe-shell
```

Add:

- `monitor_inspect` — ownership, lease, recovery, process receipts;
- `monitor_recover` — list/approve/reject quarantined watchers;
- `monitor_gc` — checkpoint and external-state cleanup, dry-run by default;
- `monitor_kill_all` — scoped to current session and extension-owned groups, with confirmation.

### 13.2 Status output

Status must display logical identity and lifecycle:

```text
qwen-archive · 8f31… [poll/local] state=quarantined
owner=none recovery=confirm expires=2026-08-02T12:00Z
lastTick=timeout failures=3 reason=abnormal-restart-loop
```

### 13.3 Startup UX

Do not emit one notification per reconstructed historical record. Emit one summary:

```text
monitor recovery: 2 resumed, 1 reused, 3 expired, 2 quarantined, 4 stale records compacted
```

---

## 14. Skill and prompt guard changes

Update `skills/monitor/SKILL.md`, README, tool descriptions, prompt guidelines, and `/watch`.

Required rules:

1. Poll commands are read-only, fast probes. Never place the actual job in a poll command.
2. Before creating a watcher, call `monitor_status` or rely on `reuse=return-existing`.
3. Use `spawn` for a local workload and `poll` only to observe an independently owned job.
4. Prefer file-tail or structured process/SSH probes over `pgrep -af '...|python3'` broad matching.
5. Use narrow identity: PID file, workflow/run ID, exact path, or remote job ID.
6. Set an absolute lifetime for temporary watchers.
7. Local poll watchers default to `confirm` recovery.
8. Never auto-resume after repeated abnormal host restarts; inspect first.
9. A timeout means stop and diagnose, not launch an identical watcher immediately.
10. Do not combine a monitor-launched job with blocking `bash` retries of the same job.

Tool-level safeguards must enforce the important invariants; skill text is defense in depth, not the only protection.

---

## 15. Modular implementation plan

The current source exceeds the project’s 400-line limit. Split by responsibility, keeping every source file under 400 lines:

```text
extensions/monitor/index.ts          registration and wiring
extensions/monitor/types.ts          schemas and state types
extensions/monitor/identity.ts       canonicalization and fingerprints
extensions/monitor/state.ts          event reduction and checkpoints
extensions/monitor/leases.ts         atomic ownership registry
extensions/monitor/process.ts        process groups and receipts
extensions/monitor/spawn.ts          spawn watcher
extensions/monitor/poll.ts           poll watcher and backoff
extensions/monitor/file.ts           file watcher
extensions/monitor/recovery.ts       policy, quarantine, crash-loop fuse
extensions/monitor/pressure.ts       optional host-pressure adapter
extensions/monitor/tools.ts          tool definitions
extensions/monitor/commands.ts       slash commands
```

Recommended milestones:

### M1 — correctness foundation

- versioned logical IDs;
- active-branch reduction;
- preserve ID on recovery;
- no append-on-resume creation;
- exact in-process reuse;
- absolute expiry;
- regression tests for the incident transcript shape.

### M2 — cross-process safety

- atomic lease registry;
- owner epochs and boot/process-start validation;
- quarantine and crash-loop fuse;
- dedicated process groups and verified teardown.

### M3 — GC and observability

- checkpoint protocol;
- external state GC;
- inspect/recover/gc tools;
- process receipts and summarized startup report.

### M4 — policy and ergonomics

- structured probes;
- local-shell classification;
- host-pressure circuit breaker;
- skill/README/prompt rewrite;
- migration and release documentation.

Commit each milestone independently.

---

## 16. Required tests

### State reducer

- ignores records outside the active branch;
- latest revision wins per logical ID;
- terminal state cannot be resurrected by an older event;
- checkpoint high-water behavior is correct;
- malformed/future-version records quarantine rather than execute;
- legacy v1 records migrate deterministically.

### Reuse

- repeated identical calls return the same logical watcher;
- equivalent canonical config reuses despite harmless formatting differences;
- `parallel` intentionally creates two logical IDs;
- command equality alone does not merge separately keyed watchers.

### Recovery

- clean restart restores one safe watcher;
- recovery keeps the same logical ID;
- recovery does not append another `created` record;
- two extension instances racing for one watcher yield exactly one lease owner;
- stale lease is reclaimed only after PID, boot ID, and process-start validation;
- branch navigation cannot resurrect an abandoned watcher;
- repeated abnormal restart trips quarantine/fuse.

### Poll execution

- tick timeout kills the owned process group;
- grandchildren cannot survive stop;
- overlapping ticks never occur;
- backoff and jitter apply after failures;
- stdout/stderr are bounded;
- unsafe local workload command defaults to confirmation/quarantine;
- SSH/file-tail safe cases continue to auto-resume.

### GC

- terminal watcher releases all timers/listeners/maps;
- checkpoint reduces thousands of historical events to the correct active set;
- stale lease cleanup is safe and idempotent;
- no PID is killed without owner validation.

### Incident replay

Build a fixture derived from session `019fbca6-…` with repeated legacy watcher records, multiple restart cycles, tombstones, and duplicated source commands. Assert:

```text
active logical watchers after reduction: expected bounded set
live local owners after concurrent recovery: exactly one per logical ID
new workload launches from poll commands: zero
journal growth per restart without state change: zero or one lease heartbeat/checkpoint, never N starts
```

### Soak/fault injection

- 100 restart cycles;
- kill -9 during claim/start/stop/checkpoint boundaries;
- two Pi processes open the same session;
- system clock changes;
- missing cwd/log file;
- child ignores SIGTERM;
- memory pressure adapter unavailable;
- corrupted lease file;
- no UI mode.

---

## 17. Acceptance criteria

The work is complete only when all are true:

1. one logical watcher cannot acquire two live local owners across processes;
2. recovery never creates a new logical watcher ID;
3. unchanged recovery does not append duplicate start records;
4. only active-branch state participates in recovery;
5. local poll commands cannot silently act as recurring workload launchers;
6. poll ticks have timeout, backoff, byte caps, and owned process-group cleanup;
7. repeated abnormal restart quarantines instead of auto-replaying;
8. absolute watcher expiry survives restart correctly;
9. stale state and leases are garbage-collected safely;
10. `monitor_status`/`monitor_inspect` can attribute every owned child;
11. existing SSH poll and file-tail workflows remain non-blocking and auto-resumable;
12. incident replay and concurrent-owner tests pass;
13. all source files remain at or below 400 lines;
14. README, changelog, skill, prompt, and migration docs agree with runtime behavior.

---

## 18. Migration and compatibility

- Read legacy `monitor-watcher` records but never write the legacy shape.
- Migrate legacy records into one deterministic logical watcher per reduced active source on the active branch.
- Default legacy local polls to `confirm`, not `safe-auto`.
- Treat old relative timeout as `createdAt + timeoutSeconds` when creation time is recoverable; otherwise quarantine expired/ambiguous records.
- Keep existing `monitor`, `monitor_status`, and `monitor_kill` names and basic parameters.
- Do not silently change remote SSH/file-tail behavior unless safety classification is ambiguous.
- Release as a semver minor only if defaults remain compatible; use a major release if local poll recovery behavior changes broadly.

---

## 19. Non-goals

- Replacing Restate/Trigger.dev as the durable workflow engine.
- Managing or killing arbitrary system processes.
- Guaranteeing host stability against a single intentionally destructive command.
- Persisting spawn-mode jobs across Pi death.
- Building a full shell security sandbox.
- Inferring job completion solely from process names.

`pi-process-monitor` should observe durable jobs and safely own bounded local child processes. Long-running, retryable computation still belongs in a real workflow substrate.

---

## 20. Immediate safe patch before the full redesign

If a full redesign cannot ship immediately, release a narrow emergency patch:

1. recover from `getBranch()`, not `getEntries()`;
2. preserve persisted watcher ID during resume;
3. add a `restoring` path that does not append a new start record;
4. dedupe exact fingerprints before launch;
5. default local poll recovery to disabled/confirm;
6. set per-tick timeout and TERM/KILL escalation;
7. add a session-level abnormal-recovery fuse;
8. collapse startup notifications into one summary;
9. document that poll commands must never launch workloads;
10. add the incident replay test.

This patch reduces immediate risk, but leases and checkpoint GC remain required for the complete fix.

---

## 21. Evidence and grounding

Reviewed on 2026-08-02:

- affected Pi session transcript `019fbca6-5020-72b6-acb3-d2da1888472c`;
- macOS panic reports under `/Library/Logs/DiagnosticReports/Retired/`;
- reset counters under `/Library/Logs/DiagnosticReports/`;
- current `pi-process-monitor` source at commit `91fed57`;
- installed monitor skill reporting tested package 1.2.0;
- project `package.json` reporting 1.3.0;
- Pi extension lifecycle documentation: `docs/extensions.md`;
- Pi session format and active-branch APIs: `docs/session-format.md`;
- Pi SDK session/runtime documentation: `docs/sdk.md`.

The installed/runtime version mismatch must be included in reproduction testing: fixes present in repository 1.3.0 cannot be assumed to protect sessions still loading 1.2.0.
