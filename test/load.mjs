import assert from "node:assert/strict";

const tools = [];
const commands = [];
const events = {};
const sent = [];
const entries = [];
const pi = {
  on: (event, handler) => { events[event] = handler; },
  registerTool: (definition) => tools.push(definition),
  registerCommand: (name, options) => commands.push({ name, ...options }),
  registerMessageRenderer: () => {},
  sendMessage: (message) => sent.push(message),
  appendEntry: (customType, data) => entries.push({ type: "custom", id: String(entries.length), timestamp: new Date().toISOString(), customType, data }),
};
const ctx = {
  cwd: "/tmp", hasUI: false, mode: "print",
  sessionManager: { getSessionId: () => `smoke-${process.pid}`, getBranch: () => entries },
  ui: { notify: () => {} },
};
const { default: factory } = await import("../extensions/monitor/index.ts");
factory(pi);

assert.deepEqual(tools.map((tool) => tool.name).sort(), [
  "monitor", "monitor_gc", "monitor_inspect", "monitor_kill", "monitor_kill_all", "monitor_recover", "monitor_status",
]);
assert.deepEqual(commands.map((command) => command.name).sort(), [
  "monitor", "monitor-gc", "monitor-kill", "monitor-recover", "monitors",
]);
await events.session_start({}, ctx);

const monitor = tools.find((tool) => tool.name === "monitor");
const status = tools.find((tool) => tool.name === "monitor_status");
const inspect = tools.find((tool) => tool.name === "monitor_inspect");
const kill = tools.find((tool) => tool.name === "monitor_kill");

const launched = await monitor.execute("id", { command: "echo DONE", coalesceSeconds: 0 }, undefined, undefined, ctx);
assert.equal(launched.details.action, "created");
assert.equal(launched.details.watcher.mode, "spawn");
const id = launched.details.watcher.id;
const inspected = await inspect.execute("id", { id }, undefined, undefined, ctx);
assert.equal(inspected.details.watcher.logicalId, launched.details.watcher.logicalId);
await new Promise((resolve) => setTimeout(resolve, 250));
assert.ok(sent.some((message) => /PROCESS EXITED/.test(message.content)));

const unsafe = await monitor.execute("id", { command: "python train.py", intervalSeconds: 30 }, undefined, undefined, ctx);
assert.equal(unsafe.details.action, "quarantined");
assert.equal(unsafe.details.watcher.state, "quarantined");
await kill.execute("id", { id: unsafe.details.watcher.id }, undefined, undefined, ctx);
const current = await status.execute("id", {}, undefined, undefined, ctx);
assert.equal(current.details.watchers.length, 0);

await events.session_shutdown({}, ctx);
console.log("✓ extension load/runtime smoke passed");
