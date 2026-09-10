# Expiry overflow repair

## Source change

Base: pi-process-monitor 2.0.2, commit `3c4c71fe1597e1ec6aaa8902c5f6e205295a8a50`.

`extensions/monitor/runtime.ts` now schedules expiry in chunks of at most
2,147,483,647 ms. Every callback checks the original absolute expiry against
`Date.now()` and rearms if time remains. Only a reached deadline calls
`watcher.stop("expire")`. Cleanup clears the current chunk; stopped callbacks
cannot rearm or expire. Every chunk remains unrefed. File length: 318 lines.

Previously working automation failed: yes, per the supplied incident evidence.
Cause identified and fixed in its original source path: yes. The supplied
2,592,187,921 ms delay overflowed Node v26's timer limit and became 1 ms.
Watcher `034a3af4f` was created at 01:56:52.054Z, claimed at .079 and expired
at .098, before fast_session at 01:57:30. Compaction was not the cause.
No recovery policy or historical expired record was changed.

## Verification

Executed on Node v26.0.0:

- `npm run typecheck`: passed (`tsc --noEmit -p tsconfig.json`).
- `node --test test/state.test.mjs`: 9 passed, 0 failed.
- `node /tmp/pi-monitor-expiry-verification.mjs`: all assertions passed.
  The harness transpiles the actual runtime source into an isolated VM with
  a controlled clock, fake timers and stubbed resources/leases. It invokes
  `startResources` on an in-memory fixture without launching a watcher,
  starting a session, acquiring a lease or executing any workload.
- Exact incident delay: first chunk 2,147,483,647 ms, second 444,704,274 ms;
  callback at deadline minus 1 ms rearms for 1 ms with zero early expiries;
  callback at deadline produces exactly one expiry and one cleanup.
- Stop, release and quarantine cancel the rearmed chunk; stale callbacks
  are inert. Initial-chunk cancellation also passed.
- Multiple full chunks, clock rollback, late wakeup, past/due/1 ms/exact-limit/
  limit-plus-1 deadlines, absent expiry and unref on every chunk passed.
- Initial harness failure: two microtask yields did not await the VM's async
  cleanup. Replaced that harness wait with one `setImmediate` turn; the same
  production source then passed. No production workaround was added.
- `git diff --check`: passed.
- `graphify update .`: completed, AST-only; generated graph files are ignored.

Harness output: `/tmp/pi-monitor-expiry-verification.log`.
Harness SHA-256: `60fc6dbcdc232ac8886354485458cb209a68f7c100f89ac281ec9d8c906e9fd6`.
Runtime SHA-256: `00a7a782124798c1a12c659356545724a43006172d1cf890ca01018cb23c5232`.

No new repository tests were added. Full runtime, smoke and real-Pi suites were
not run because they create watchers or start Pi. No build script is defined.
Read the complete installed Pi 0.85.1 extension and package docs and the
file-trigger example before implementation; lifecycle cleanup remains in the
existing stop path.

## Deployment and scope

Source editing does not replace the loaded runtime. A later explicit Pi reload
or restart is required to activate this repair. No reload, watcher creation,
shortened-expiry workaround or historical watcher recovery was performed.
No H3 worktree or active Hammersmith execution was touched.

The pre-existing dirty `skills/monitor/SKILL.md` was preserved byte-for-byte and
excluded from the commit. Its SHA-256 before and after is
`bebe5e55827d785cecdb89d7e299e99b039d92c999ef23404c3e984d736ee0ae`.
