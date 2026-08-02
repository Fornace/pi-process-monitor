import assert from "node:assert/strict";
import test from "node:test";
import { nextEvent, reduceState } from "../extensions/monitor/state.ts";

const config = { logFile: "/tmp/fault.log", cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "return-existing" };
function snapshot(event) {
  return { logicalId: event.logicalId, revision: event.revision, state: event.event, mode: event.mode, sourceFingerprint: event.sourceFingerprint, createdAt: event.createdAt, updatedAt: event.updatedAt, recoveryPolicy: event.recoveryPolicy, config: event.config, owner: event.owner };
}
function entry(data) { return { type: "custom", id: `${data.logicalId}-${data.revision}`, timestamp: data.updatedAt, customType: "monitor-state-v2", data }; }
function base() {
  const created = nextEvent(undefined, { logicalId: "fault", event: "created", mode: "file", sourceFingerprint: "f", updatedAt: "2026-08-02T10:00:00Z", recoveryPolicy: "safe-auto", config });
  const previousRuntime = "r";
  const owner = { runtimeId: previousRuntime, ownerEpoch: "e", pid: 1, bootId: "b", processStart: "s", leaseUntil: "2026-08-02T10:01:00Z" };
  const claimed = nextEvent(snapshot(created), { logicalId: "fault", event: "claimed", mode: "file", sourceFingerprint: "f", owner, updatedAt: "2026-08-02T10:00:01Z", recoveryPolicy: "safe-auto", config });
  return { created, claimed };
}

test("kill -9 at claim boundary reduces to one claimable logical watcher", () => {
  const { created, claimed } = base();
  const reduced = reduceState([entry(created), entry(claimed)]);
  assert.equal(reduced.watchers.size, 1);
  assert.equal(reduced.watchers.get("fault").state, "claimed");
});

test("kill -9 at start boundary never creates a second logical id", () => {
  const { created, claimed } = base();
  const heartbeat = nextEvent(snapshot(claimed), { logicalId: "fault", event: "heartbeat", mode: "file", sourceFingerprint: "f", owner: claimed.owner, updatedAt: "2026-08-02T10:00:02Z", recoveryPolicy: "safe-auto", config });
  const reduced = reduceState([entry(created), entry(claimed), entry(heartbeat)]);
  assert.deepEqual([...reduced.watchers.keys()], ["fault"]);
});

test("kill -9 at stop boundary leaves prior claim conservatively recoverable", () => {
  const { created, claimed } = base();
  const reduced = reduceState([entry(created), entry(claimed)]);
  assert.equal(reduced.watchers.get("fault").state, "claimed");
});

test("kill -9 before checkpoint append preserves pre-checkpoint reduction", () => {
  const { created, claimed } = base();
  const reduced = reduceState([entry(created), entry(claimed)]);
  assert.equal(reduced.watchers.get("fault").revision, 2);
});
