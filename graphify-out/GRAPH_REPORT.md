# Graph Report - pi-monitor  (2026-06-29)

## Corpus Check
- 8 files · ~5,276 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 115 nodes · 119 edges · 12 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f1be91d9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]

## God Nodes (most connected - your core abstractions)
1. `pi-monitor` - 16 edges
2. `compilerOptions` - 9 edges
3. `monitor — non-blocking background watcher` - 8 edges
4. `launch()` - 6 edges
5. `repository` - 5 edges
6. `pi` - 4 edges
7. `scripts` - 4 edges
8. `Usage (from the agent — tools)` - 4 edges
9. `Recipes` - 4 edges
10. `startSpawn()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `pi-monitor` --implements--> `monitor_kill tool`  [EXTRACTED]
  README.md → CHANGELOG.md
- `pi-monitor` --implements--> `monitor_status tool`  [EXTRACTED]
  README.md → CHANGELOG.md
- `monitor skill` --references--> `monitor_status tool`  [EXTRACTED]
  skills/monitor/SKILL.md → CHANGELOG.md
- `monitor skill` --references--> `monitor_kill tool`  [EXTRACTED]
  skills/monitor/SKILL.md → CHANGELOG.md

## Import Cycles
- None detected.

## Communities (12 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.14
Nodes (18): DEFAULT_NOTIFY, emit(), execute(), launch(), makeCoalescer(), MonitorParams, startFile(), startPoll() (+10 more)

### Community 1 - "Community 1"
Cohesion: 0.13
Nodes (16): author, bugs, url, description, engines, node, files, homepage (+8 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (11): ac, commands, entries, events, kill, killCmd, mon, pi (+3 more)

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (10): compilerOptions, allowImportingTsExtensions, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck, strict (+2 more)

### Community 4 - "Community 4"
Cohesion: 0.29
Nodes (7): devDependencies, @earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox, typescript, peerDependencies, @earendil-works/pi-coding-agent

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (16): monitor_kill tool, monitor_status tool, Default `notifyOn` (case-insensitive regex), Development, How the ping works (don't fight it), Install, License, pi.appendEntry (+8 more)

### Community 6 - "Community 6"
Cohesion: 0.50
Nodes (4): pi, extensions, prompts, skills

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (11): How the ping works (don't fight it), Lifecycle, Local dev server (spawn), ML training on a remote H100 (the canonical case), monitor — non-blocking background watcher, Pitfalls, Recipes, Tail an existing log (+3 more)

### Community 8 - "Community 8"
Cohesion: 0.50
Nodes (3): [1.0.0] — 2026-06-29, Added, Changelog

### Community 9 - "Community 9"
Cohesion: 0.50
Nodes (4): scripts, prepublishOnly, test, typecheck

### Community 10 - "Community 10"
Cohesion: 0.50
Nodes (4): `monitor_kill` — stop a watcher, `monitor` — start a watcher, `monitor_status` — list watchers, Usage (from the agent — tools)

## Knowledge Gaps
- **76 isolated node(s):** `DEFAULT_NOTIFY`, `Watcher`, `WatcherMeta`, `TextBlock`, `MonitorParams` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pi-monitor` connect `Community 5` to `Community 0`, `Community 10`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `Usage (from the agent — tools)` connect `Community 10` to `Community 5`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `Community 4` to `Community 1`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `DEFAULT_NOTIFY`, `Watcher`, `WatcherMeta` to the rest of the system?**
  _76 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.14035087719298245 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1323529411764706 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._