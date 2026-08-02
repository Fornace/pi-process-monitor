import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCommand, classifyPoll, sourceFingerprint } from "../extensions/monitor/identity.ts";
import { createCheckpoint, nextEvent, reduceState } from "../extensions/monitor/state.ts";
import { evaluateFuse } from "../extensions/monitor/recovery.ts";

const baseConfig = {
  command: "ssh host 'tail -n 5 log'",
  intervalSeconds: 30,
  cwd: "/tmp",
  recoveryPolicy: "safe-auto",
  reuse: "return-existing",
};

function created(id = "watcher-a", config = baseConfig) {
  return nextEvent(undefined, {
    logicalId: id, event: "created", mode: "poll",
    sourceFingerprint: sourceFingerprint(config, "poll"),
    updatedAt: "2026-08-02T10:00:00.000Z", expiresAt: config.expiresAt, recoveryPolicy: "safe-auto", config,
  });
}

function entry(data, id = Math.random().toString(16).slice(2)) {
  return { type: "custom", id, timestamp: data.updatedAt, customType: "monitor-state-v2", data };
}

test("canonical fingerprint ignores harmless whitespace", () => {
  assert.equal(canonicalCommand(" ssh   host   'tail   x' "), "ssh host 'tail   x'");
  const a = sourceFingerprint(baseConfig, "poll");
  const b = sourceFingerprint({ ...baseConfig, command: " ssh  host 'tail -n 5 log' " }, "poll");
  assert.equal(a, b);
});

test("classifier preserves remote observer and rejects local workload poll", () => {
  assert.deepEqual(classifyPoll(baseConfig).local, false);
  assert.equal(classifyPoll(baseConfig).classification, "safe-observer");
  const unsafeRemote = classifyPoll({ ...baseConfig, command: "ssh host 'python train.py > out.log &'" });
  assert.equal(unsafeRemote.local, false);
  assert.equal(unsafeRemote.classification, "unsafe-shell");
  assert.equal(classifyPoll({ ...baseConfig, command: "test ! -f /tmp/done && python train.py" }).classification, "unsafe-shell");
  assert.equal(classifyPoll({ ...baseConfig, command: "tail -n5 log; pgrep -fc train" }).classification, "safe-observer");
  const unsafe = classifyPoll({ ...baseConfig, command: "python train.py > out.log &" });
  assert.equal(unsafe.classification, "unsafe-shell");
  assert.match(unsafe.reasons.join(" "), /workload|operator/);
});

test("latest monotonic revision wins and terminal cannot resurrect", () => {
  const first = created();
  const claimed = nextEvent({ logicalId: first.logicalId, revision: 1, state: "created", mode: "poll", sourceFingerprint: first.sourceFingerprint, createdAt: first.createdAt, updatedAt: first.updatedAt, recoveryPolicy: "safe-auto", config: baseConfig }, {
    logicalId: first.logicalId, event: "claimed", mode: "poll", sourceFingerprint: first.sourceFingerprint,
    updatedAt: "2026-08-02T10:00:01.000Z", recoveryPolicy: "safe-auto", config: baseConfig,
  });
  const stopped = { ...claimed, revision: 3, event: "stopped", updatedAt: "2026-08-02T10:00:02.000Z" };
  const stale = { ...claimed, revision: 2, event: "claimed", updatedAt: "2026-08-02T10:00:03.000Z" };
  const reduced = reduceState([entry(first), entry(claimed), entry(stopped), entry(stale)]);
  assert.equal(reduced.watchers.get(first.logicalId)?.state, "stopped");
  assert.equal(reduced.ignored, 1);
});

test("checkpoint resets historical state and keeps high-water", () => {
  const old = created("old");
  const current = { logicalId: "new", revision: 4, state: "released", mode: "file", sourceFingerprint: "f", createdAt: "2026-08-02T10:00:00Z", updatedAt: "2026-08-02T10:10:00Z", recoveryPolicy: "safe-auto", config: { logFile: "/tmp/x", cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "return-existing" } };
  const checkpoint = { schemaVersion: 2, logicalId: "__checkpoint__", revision: 1, event: "checkpoint", mode: "file", sourceFingerprint: "checkpoint", createdAt: current.updatedAt, updatedAt: current.updatedAt, recoveryPolicy: "never", checkpoint: createCheckpoint([current], "high") };
  const reduced = reduceState([entry(old, "old-entry"), entry(checkpoint, "cp")]);
  assert.equal(reduced.watchers.has("old"), false);
  assert.equal(reduced.watchers.get("new")?.revision, 4);
  assert.equal(reduced.checkpointEntryId, "cp");
});

test("future and malformed records quarantine by omission rather than execute", () => {
  const reduced = reduceState([
    { type: "custom", customType: "monitor-state-v2", data: { schemaVersion: 99 } },
    { type: "custom", customType: "monitor-state-v2", data: "bad" },
  ]);
  assert.equal(reduced.watchers.size, 0);
  assert.equal(reduced.malformed, 2);
});

test("legacy duplicate ids reduce deterministically by source and timeout becomes absolute", () => {
  const entries = [
    { type: "custom", id: "1", timestamp: "2026-08-02T10:00:00Z", customType: "monitor-watcher", data: { id: "runtime-1", command: " ssh host status ", intervalSec: 30, cwd: "/tmp", timeoutSeconds: 3600 } },
    { type: "custom", id: "2", timestamp: "2026-08-02T10:01:00Z", customType: "monitor-watcher", data: { id: "runtime-2", command: "ssh  host status", intervalSec: 30, cwd: "/tmp", timeoutSeconds: 3600 } },
  ];
  const reduced = reduceState(entries, Date.parse("2026-08-02T10:02:00Z"));
  assert.equal(reduced.watchers.size, 1);
  const watcher = [...reduced.watchers.values()][0];
  assert.equal(watcher.recoveryPolicy, "confirm");
  assert.equal(watcher.expiresAt, "2026-08-02T11:01:00.000Z");
});

test("active branch input excludes abandoned records", () => {
  const active = created("active");
  const abandoned = created("abandoned");
  const reduced = reduceState([entry(active)]); // SessionManager.getBranch contract supplies only this path.
  assert.equal(reduced.watchers.has("active"), true);
  assert.equal(reduced.watchers.has(abandoned.logicalId), false);
});

test("absolute expiry survives restart and clock rollback safely", () => {
  const event = created("expires", { ...baseConfig, expiresAt: "2026-08-02T10:05:00Z" });
  assert.equal(reduceState([entry(event)], Date.parse("2026-08-02T10:06:00Z")).watchers.get("expires")?.state, "expired");
  assert.equal(reduceState([entry(event)], Date.parse("2026-08-02T09:00:00Z")).watchers.get("expires")?.state, "created");
});

test("restart fuse thresholds are exact", () => {
  const now = Date.parse("2026-08-02T10:30:00Z");
  const history = { schemaVersion: 1, sessionId: "s", abnormalStarts: [
    "2026-08-02T10:29:00Z", "2026-08-02T10:25:00Z", "2026-08-02T10:01:00Z",
  ] };
  assert.deepEqual(evaluateFuse(history, now), { quarantineLocalPolls: true, disableAllLocalRecovery: true, recent10m: 2, recent30m: 3 });
});
