import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { reduceState } from "../extensions/monitor/state.ts";

function legacy(id, command, timestamp, stopped = false) {
  return { type: "custom", id, timestamp, customType: "monitor-watcher", data: { id, command, intervalSec: 30, cwd: "/tmp", stopped } };
}

const fixture = [
  legacy("qwen-a-1", " test -f /tmp/qwen-int4-language/archive.done && echo DONE ", "2026-08-02T09:00:00Z"),
  legacy("qwen-a-2", "test  -f /tmp/qwen-int4-language/archive.done && echo DONE", "2026-08-02T09:05:00Z"),
  legacy("qwen-b-1", "test -f /tmp/qwen-vision-bf16-language/convert.done && echo DONE", "2026-08-02T09:01:00Z"),
  legacy("qwen-b-2", "test  -f /tmp/qwen-vision-bf16-language/convert.done && echo DONE", "2026-08-02T09:06:00Z"),
  legacy("qwen-stopped", "test -f /tmp/old.done && echo DONE", "2026-08-02T08:00:00Z"),
  legacy("qwen-stopped-2", "test -f /tmp/old.done && echo DONE", "2026-08-02T08:10:00Z", true),
];

test("incident replay reduces duplicate resume history to bounded logical set", () => {
  const reduced = reduceState(fixture, Date.parse("2026-08-02T09:10:00Z"));
  const active = [...reduced.watchers.values()].filter((watcher) => !["stopped", "expired"].includes(watcher.state));
  assert.equal(reduced.watchers.size, 3);
  assert.equal(active.length, 2);
  assert.ok(active.every((watcher) => watcher.recoveryPolicy === "confirm"));
  assert.ok(active.every((watcher) => watcher.legacy));
});

test("100 unchanged recovery reductions launch no local workload and grow no journal", () => {
  let source = fixture;
  for (let cycle = 0; cycle < 100; cycle++) {
    const reduced = reduceState(source, Date.parse("2026-08-02T09:10:00Z") + cycle * 1000);
    const active = [...reduced.watchers.values()].filter((watcher) => !["stopped", "expired"].includes(watcher.state));
    assert.equal(active.length, 2);
    assert.ok(active.every((watcher) => watcher.state === "released"));
    // Pure reduction never appends: caller sees the same active branch on every crash boundary.
    assert.equal(source.length, fixture.length);
  }
});

test("100 fresh Node runtime reconstructions converge through checkpoint boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "monitor-restarts-"));
  const input = join(root, "entries.json");
  const output = join(root, "result.json");
  const worker = new URL("./fixtures/restart-worker.mjs", import.meta.url).pathname;
  try {
    writeFileSync(input, JSON.stringify(fixture));
    for (let cycle = 0; cycle < 100; cycle++) {
      execFileSync(process.execPath, [worker, input, output]);
      const result = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(result.active, 2);
      assert.equal(result.total, 3);
      assert.ok(result.checkpoint.active.length <= 2);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("abandoned branch incident records cannot resurrect", () => {
  const activeBranch = fixture.slice(4); // SessionManager.getBranch excludes the Qwen branch.
  const reduced = reduceState(activeBranch);
  assert.equal([...reduced.watchers.values()].filter((watcher) => watcher.state !== "stopped").length, 0);
});
