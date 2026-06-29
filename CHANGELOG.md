# Changelog

All notable changes to **pi-monitor** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-29
### Added
- `monitor` tool: non-blocking background watcher with three sources —
  `spawn` (local process, tail until exit), `poll` (re-run a command on an
  interval; ideal for SSH/remote), `file` (tail appended log lines).
- **Conditional delivery**: only lines matching `notifyOn` (default milestones +
  failures) plus process exit are pushed — no per-line LLM turns.
- **Coalescing**: rapid matching lines merged into one message (default 2s
  window, max 20 lines).
- `monitor_status` tool + `/monitors` command to list active watchers.
- `monitor_kill` tool + `/monitor-kill <id>` command. The command autocompletes
  live watcher ids; spawn mode SIGTERMs then SIGKILLs the child.
- `/monitor <cmd>` command (with `--poll`/`--every N`/`--file` flags) for
  human-driven starts.
- **Restart-resume**: poll & file watchers persist via `appendEntry` and
  re-attach within the same session after a pi restart, announcing themselves.
- `heartbeatMinutes` for silent-but-alive jobs.
- Custom message rendering (colored watcher id + label).
- `monitor` skill (auto-invoked when the agent detects a long-running job) and
  `/watch` prompt template.

[1.0.0]: https://github.com/Fornace/pi-process-monitor/releases/tag/v1.0.0
