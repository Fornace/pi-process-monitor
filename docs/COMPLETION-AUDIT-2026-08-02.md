# Completion audit — crash-safe recovery brief

**Date:** 2026-08-02  
**Validation:** `npm run validate` — typecheck, 40 tests, extension smoke, package dry-run  
**Source-size maximum:** 305 lines (`extensions/monitor/runtime.ts`)

| Acceptance criterion | Evidence |
|---|---|
| 1. At most one live local owner | `leases.ts`; atomic in-process and eight-real-process races in `leases.test.mjs` |
| 2. Recovery retains logical ID | `runtime.ts`; `safe file recovery preserves logical id` |
| 3. No duplicate start on unchanged recovery | `runtime.test.mjs`; incident 100-cycle tests |
| 4. Active branch only | `runtime.ts:getBranch`; active/abandoned branch tests |
| 5. Local polls cannot silently schedule work | `identity.ts`; local/remote compound classifier and zero-launch quarantine tests |
| 6. Poll timeout/backoff/caps/group cleanup | `poll.ts`, `process.ts`; poll/process tests |
| 7. Abnormal restart quarantines | `recovery.ts`, `runtime.ts`; fuse and fault-boundary tests |
| 8. Absolute expiry survives restart | state/clock tests; `timeoutSeconds` one-time conversion |
| 9. Safe state/lease GC | checkpoint reducer, non-mutating dry-run/apply GC tests, corrupt/stale lease tests |
| 10. Child attribution | status/inspect metadata and bounded receipt history |
| 11. SSH/file workflows remain auto-resumable | structured SSH classification, file no-UI and recovery tests |
| 12. Incident/concurrent-owner tests pass | incident replay, 100 fresh runtimes, real process lease race |
| 13. All source files <=400 lines | fresh `wc -l` audit; max 305 |
| 14. Docs/runtime agreement | README, changelog, skill, prompt, migration, grounding and package-content audit |

Additional required evidence:

- malformed/future state fails closed;
- PID reuse requires matching boot/process-start identity;
- child ignoring TERM escalates to KILL with cleanup receipt;
- missing file/cwd and failed startup do not leak a lease;
- host pressure unavailable preserves core identity protections;
- no-UI file observation works;
- installed 1.2.0 fixture and effective 1.1.0 package mismatch are reproduced;
- package dry-run includes runtime modules and migration/grounding docs;
- git worktree is clean and implementation is split into coherent commits.
