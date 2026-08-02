import { readFileSync, writeFileSync } from "node:fs";
import { reduceState, createCheckpoint } from "../../extensions/monitor/state.ts";

const [input, output] = process.argv.slice(2);
const entries = JSON.parse(readFileSync(input, "utf8"));
const reduced = reduceState(entries, Date.parse("2026-08-02T12:00:00Z"));
const checkpoint = createCheckpoint(reduced.watchers.values(), entries.at(-1)?.id, Date.parse("2026-08-02T12:00:00Z"));
writeFileSync(output, JSON.stringify({
  active: [...reduced.watchers.values()].filter((watcher) => !["stopped", "expired"].includes(watcher.state)).length,
  total: reduced.watchers.size,
  malformed: reduced.malformed,
  ignored: reduced.ignored,
  checkpoint,
}));
