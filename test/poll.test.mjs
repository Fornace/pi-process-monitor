import assert from "node:assert/strict";
import test from "node:test";
import { startPollRuntime } from "../extensions/monitor/poll.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function watcher(command, overrides = {}) {
  return {
    logicalId: "poll-test", handleId: "polltest", label: "", mode: "poll", state: "claimed",
    config: { command, intervalSeconds: 2, pollTimeoutSeconds: 0.05, maxConsecutiveFailures: 2, backoffMaxSeconds: 4, cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "return-existing", ...overrides },
    sourceFingerprint: "f", revision: 2, createdAt: Date.now(), lastEventAt: null,
    lastTickAt: null, eventCount: 0, consecutiveFailures: 0, owner: { ownerEpoch: "epoch" }, stop: async () => {},
  };
}

const normal = async (ownedChildren) => ({ level: "normal", sampledAt: new Date().toISOString(), ownedChildren, reasons: ["normal"] });

test("poll ticks never overlap even while async pressure sampling is pending", async () => {
  const w = watcher("sleep 0.2");
  let samples = 0;
  const slowPressure = async (ownedChildren) => { samples++; await wait(50); return normal(ownedChildren); };
  const controller = startPollRuntime({ watcher: w, command: w.config.command, matcher: () => false, push: () => {}, onFailure: () => {}, onCriticalPressure: () => {}, ownedChildren: () => 0, pressureSample: slowPressure });
  await Promise.all([controller.tickNow(), controller.tickNow(), controller.tickNow()]);
  assert.equal(samples, 1);
  await wait(20);
  const firstPid = w.child?.pid;
  await Promise.all([controller.tickNow(), controller.tickNow(), controller.tickNow()]);
  assert.equal(w.child?.pid, firstPid);
  await controller.stop();
});

test("poll timeout stops group, increments failures, applies bounded backoff, and suspends", async () => {
  const messages = [];
  const w = watcher("sleep 30");
  const controller = startPollRuntime({ watcher: w, command: w.config.command, matcher: () => false, push: () => {}, onFailure: (message) => messages.push(message), onCriticalPressure: () => {}, ownedChildren: () => 0, pressureSample: normal, random: () => 0.5 });
  await wait(1200); // TERM grace inside timeout path is 1s.
  assert.equal(w.consecutiveFailures, 1);
  assert.match(messages.join(" "), /POLL TIMEOUT/);
  assert.ok((w.nextTickAt - Date.now()) <= 4100);
  await wait(Math.max(0, w.nextTickAt - Date.now()) + 100);
  await controller.tickNow();
  await wait(1200);
  assert.equal(w.consecutiveFailures, 2);
  assert.match(messages.join(" "), /POLL SUSPENDED/);
  await controller.stop();
});

test("critical host pressure quarantines before process launch", async () => {
  const w = watcher("echo should-not-run");
  let critical;
  const controller = startPollRuntime({ watcher: w, command: w.config.command, matcher: () => false, push: () => {}, onFailure: () => {}, onCriticalPressure: (sample) => { critical = sample; }, ownedChildren: () => 9, pressureSample: async (ownedChildren) => ({ level: "critical", sampledAt: new Date().toISOString(), ownedChildren, reasons: ["test pressure"] }) });
  await wait(20);
  assert.equal(w.child, undefined);
  assert.equal(critical.level, "critical");
  await controller.stop();
});

test("telemetry unavailable does not bypass identity protections or block safe observer", async () => {
  const w = watcher("echo DONE", { pollTimeoutSeconds: 1 });
  const controller = startPollRuntime({ watcher: w, command: w.config.command, matcher: () => true, push: () => {}, onFailure: () => {}, onCriticalPressure: () => {}, ownedChildren: () => 0, pressureSample: async (ownedChildren) => ({ level: "unavailable", sampledAt: new Date().toISOString(), ownedChildren, reasons: ["unavailable"] }) });
  await wait(100);
  assert.ok(w.receipt?.pid);
  await controller.stop();
});
