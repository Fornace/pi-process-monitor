import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorRuntime } from "../extensions/monitor/runtime.ts";

function harness(sessionId = `runtime-${process.pid}-${Math.random()}`) {
  const entries = [];
  const sent = [];
  const notices = [];
  const pi = {
    appendEntry: (customType, data) => entries.push({ type: "custom", id: String(entries.length + 1), timestamp: new Date().toISOString(), customType, data }),
    sendMessage: (message) => sent.push(message),
  };
  const ctx = {
    cwd: "/tmp", hasUI: false, mode: "print",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    ui: { notify: (message) => notices.push(message) },
  };
  return { entries, sent, notices, pi, ctx };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup(runtime) {
  try { await runtime.shutdown(); } catch { /* test cleanup */ }
  await rm(join(process.env.HOME, ".pi", "agent", "state", "pi-process-monitor", runtime.getSessionId()), { recursive: true, force: true });
}

test("repeated identical calls return one logical watcher and append no second created event", async () => {
  const h = harness();
  const runtime = new MonitorRuntime(h.pi);
  await runtime.startSession(h.ctx);
  const config = { logFile: `/tmp/reuse-${process.pid}`, cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "return-existing" };
  const first = await runtime.launch(config);
  const count = h.entries.length;
  const second = await runtime.launch(config);
  assert.equal(second.action, "reused");
  assert.equal(second.watcher.logicalId, first.watcher.logicalId);
  assert.equal(h.entries.length, count);
  await cleanup(runtime);
});

test("parallel creates distinct ids only when explicitly keyed", async () => {
  const h = harness();
  const runtime = new MonitorRuntime(h.pi);
  await runtime.startSession(h.ctx);
  const path = `/tmp/parallel-${process.pid}`;
  const first = await runtime.launch({ logFile: path, cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "parallel", reuseKey: "a" });
  const second = await runtime.launch({ logFile: path, cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "parallel", reuseKey: "b" });
  assert.notEqual(first.watcher.logicalId, second.watcher.logicalId);
  await cleanup(runtime);
});

test("safe file recovery preserves logical id and appends claimed, never created", async () => {
  const h = harness();
  const firstRuntime = new MonitorRuntime(h.pi);
  await firstRuntime.startSession(h.ctx);
  const launched = await firstRuntime.launch({ logFile: `/tmp/recover-${process.pid}`, cwd: "/tmp", recoveryPolicy: "safe-auto", reuse: "return-existing" });
  await firstRuntime.shutdown();
  const before = h.entries.length;
  const secondRuntime = new MonitorRuntime(h.pi);
  await secondRuntime.startSession(h.ctx);
  const restored = secondRuntime.find(launched.watcher.logicalId);
  assert.equal(restored?.logicalId, launched.watcher.logicalId);
  const newEvents = h.entries.slice(before).map((entry) => entry.data.event);
  assert.equal(newEvents.includes("created"), false);
  assert.equal(newEvents.includes("claimed"), true);
  await cleanup(secondRuntime);
});

test("local shell poll defaults to quarantine and launches zero workload processes", async () => {
  const h = harness();
  const runtime = new MonitorRuntime(h.pi);
  await runtime.startSession(h.ctx);
  const marker = join(tmpdir(), `monitor-marker-${process.pid}`);
  await rm(marker, { force: true });
  const result = await runtime.launch({ command: `echo bad > ${marker}`, intervalSeconds: 2, cwd: "/tmp", recoveryPolicy: "confirm", reuse: "return-existing" });
  assert.equal(result.action, "quarantined");
  assert.equal(result.watcher.child, undefined);
  await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(marker)));
  await cleanup(runtime);
});

test("file observer works in no-UI mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-file-"));
  const file = join(root, "log");
  await writeFile(file, "initial\n");
  const h = harness();
  const runtime = new MonitorRuntime(h.pi);
  await runtime.startSession({ ...h.ctx, ui: undefined });
  const result = await runtime.launch({ logFile: file, notifyOn: ["DONE"], cwd: root, recoveryPolicy: "safe-auto", reuse: "return-existing", coalesceSeconds: 0 });
  await writeFile(file, "initial\nDONE\n");
  await wait(250);
  assert.ok(h.sent.some((message) => message.content.includes("DONE")));
  await cleanup(runtime);
  await rm(root, { recursive: true, force: true });
});
