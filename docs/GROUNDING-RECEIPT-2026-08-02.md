# Crash-safe recovery grounding receipt

**Reviewed:** 2026-08-02  
**Repository base:** `91fed57` plus brief commit `d7d2202`  
**Local development package:** `@earendil-works/pi-coding-agent@0.80.2`  
**Global Pi CLI observed by audit:** `0.82.1`  
**Registry latest observed:** `@earendil-works/pi-coding-agent@0.83.0`, `pi-process-monitor@1.3.0`  
**Effective Pi-managed monitor:** `1.1.0` (brief expected 1.2.0; both prove version skew)

## Authoritative sources

| Source | URL/path | Raw response / receipt |
|---|---|---|
| Pi extension lifecycle | https://raw.githubusercontent.com/earendil-works/pi-mono/main/packages/coding-agent/docs/extensions.md | HTTP 200; 119,937 bytes; SHA-256 `95a6b3146af5c279cb5698158d18f7a5c22683793293604b5c430bbc28ddcf17` |
| Pi session format | https://raw.githubusercontent.com/earendil-works/pi-mono/main/packages/coding-agent/docs/session-format.md | HTTP 200; 16,744 bytes; SHA-256 `c0f25475ab08fb96e244e6bf433aeaa41b69bfb5a52de5c7b01b81c900a84a54` |
| Pi SDK | https://raw.githubusercontent.com/earendil-works/pi-mono/main/packages/coding-agent/docs/sdk.md | HTTP 200; 35,420 bytes; SHA-256 `c34060ea771ebd782067539cd40d7020a5781761b6179759b1a537a46413af21` |
| Node child processes (v24 LTS docs) | https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/child_process.md | HTTP 200; 86,596 bytes; SHA-256 `a7faa746c3681fd0cdf708237bc840006ceceace519dcdf89360b4ea9e508538` |
| Node filesystem (v24 LTS docs) | https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/fs.md | HTTP 200; 281,480 bytes; SHA-256 `b30308c50662d81d4c4593557bb6b908320c11f62d482ba717bd139c26e5c604` |
| Installed Pi docs | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/{extensions,session-format,sdk,packages}.md` | Read completely for extension/session/SDK docs; package docs confirms directory `index.ts` and package manifest discovery. |
| Installed declarations/source | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.{d.ts,js}` | `getBranch(fromId?)` walks leaf-to-root then reverses; `getEntries()` returns every session entry. |
| Extension loader | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js` | Directory resolution checks package `pi.extensions`, then `index.ts`; discovery is one directory level. |

## Grounded design consequences

1. Start long-lived resources from `session_start`, not extension factory; clean them idempotently on `session_shutdown`.
2. Recover state from `ctx.sessionManager.getBranch()`, never `getEntries()`.
3. Package `pi.extensions: ["./extensions"]` correctly resolves `extensions/monitor/index.ts`.
4. Use `pi.appendEntry` only for versioned lifecycle events/checkpoints; custom entries do not enter LLM context.
5. On POSIX, Node `spawn({ detached: true })` creates a new process group/session. Signal the negative PGID, then verify group death; never signal a PID from stale state without boot ID and process-start validation.
6. Acquire lease files with `open(..., "wx")` (`O_CREAT|O_EXCL`); archive stale/corrupt leases before a new atomic claim.
7. Pi supports no physical rewrite API for session JSONL, so monitor GC is checkpoint-based logical compaction plus external lease cleanup.

## Raw version commands

```text
npm view pi-process-monitor version -> 1.3.0
npm view @earendil-works/pi-coding-agent version -> 0.83.0
npm ls (repository) -> @earendil-works/pi-coding-agent 0.80.2
~/.pi/agent/npm/node_modules/pi-process-monitor/package.json -> 1.1.0
```

`test/version-mismatch.test.mjs` verifies that the effective legacy install still uses `getEntries()` and append-on-resume `monitor-watcher` records, preventing false confidence from repository-only testing.
