# Crash-safe monitor protocol migration

Reviewed: 2026-08-02

## Version 2 state

New releases write `monitor-state-v2` custom entries. Each logical watcher has a stable UUID, monotonic revision, lifecycle event, canonical source fingerprint, recovery policy, absolute expiry, and optional owner lease. Recovery reads only `SessionManager.getBranch()`.

Supported lifecycle transitions:

```text
created -> claimed | quarantined | stopped | expired
claimed/heartbeat -> heartbeat | released | quarantined | stopped | expired
released/quarantined -> claimed | quarantined | stopped | expired
```

A checkpoint stores the reduced active set and up to 100 terminal summaries from the previous seven days. It is logical compaction: Pi session JSONL remains append-only.

## Legacy migration

Legacy `monitor-watcher` records remain readable and are never written:

- repeated runtime IDs collapse to one deterministic logical ID per canonical active source;
- only active-branch records participate;
- legacy local polls become `confirm` + `unsafe-shell`;
- legacy file tails become `safe-auto`;
- `createdAt + timeoutSeconds` becomes absolute `expiresAt` when a timestamp exists;
- ambiguous or malformed records fail closed rather than execute.

## Behavior changes

- Spawn recovery remains `never`.
- File tails and classified remote SSH/HTTP observers remain `safe-auto`.
- Local poll recovery requires confirmation by default.
- Raw local shell polling that looks mutating, workload-like, or ambiguous is quarantined unless the caller explicitly acknowledges `safetyClass: "observer"`.
- Repeated equivalent calls reuse the active logical watcher. Use `reuse: "replace"` or an explicit `reuseKey` with `reuse: "parallel"` for intentional divergence.
- Temporary watchers use an absolute `expiresAt`; the compatibility `timeoutSeconds` parameter is converted once at creation.

Because local poll recovery now fails closed broadly, this release must use a **major semver bump**.

## Effective installation mismatch

Pi-managed npm installs can remain pinned independently of the repository. On the incident host, repository/npm latest was 1.3.0 while the effective `~/.pi/agent/npm/node_modules/pi-process-monitor` package was 1.1.0 (the brief expected an installed 1.2.0 mismatch). `test/version-mismatch.test.mjs` records and proves the unsafe legacy shape. After release, update the Pi package through `pi update --extension npm:pi-process-monitor` or install the new major explicitly; do not assume repository checkout changes protect loaded sessions.
