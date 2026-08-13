import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { resolveMonitorInput } from "../extensions/monitor/input.ts";

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

// The provider sees one required discriminator, never three competing root sources.
assert.deepEqual(monitor.parameters.required, ["source", "options"]);
assert.deepEqual(Object.keys(monitor.parameters.properties), ["source", "options"]);
assert.equal(monitor.parameters.additionalProperties, false);
assert.deepEqual(monitor.parameters.properties.source.required, [
  "type", "command", "path", "processBy", "pidFile", "match", "host", "url", "method", "tailLines", "intervalSeconds",
]);
assert.deepEqual(monitor.parameters.properties.options.anyOf.map((schema) => schema.type), ["object", "null"]);
const optionsObject = monitor.parameters.properties.options.anyOf.find((schema) => schema.type === "object");
assert.deepEqual(optionsObject.required, Object.keys(optionsObject.properties));
assert.equal(optionsObject.additionalProperties, false);

const prepared = (args) => {
  const value = monitor.prepareArguments(args);
  assert.equal(Value.Check(monitor.parameters, value), true, JSON.stringify(value));
  return value;
};

// Minimal current and legacy calls normalize into the same strict-compatible shape.
const currentSpawn = prepared({ source: { type: "spawn", command: "echo DONE" }, options: null });
const legacySpawn = prepared({ command: "echo DONE", label: "legacy" });
assert.equal(currentSpawn.source.type, "spawn");
assert.equal(currentSpawn.source.path, null);
assert.equal(legacySpawn.source.type, "spawn");
assert.equal(legacySpawn.options.label, "legacy");
assert.equal(legacySpawn.options.expiresAt, null);

// Local shell polling remains a supported, explicit feature.
const legacyPoll = prepared({ command: "ps -p 123", intervalSeconds: 5, safetyClass: "observer" });
assert.equal(legacyPoll.source.type, "poll");
assert.equal(resolveMonitorInput(legacyPoll, "/tmp").config.intervalSeconds, 5);

const cases = [
  [{ source: { type: "poll", command: "ps -p 123", intervalSeconds: 5 }, options: null }, "poll", "poll"],
  [{ source: { type: "tail", path: "/tmp/job.log" }, options: null }, "tail", "file"],
  [{ source: { type: "process", processBy: "pidFile", pidFile: "/tmp/job.pid", intervalSeconds: 10 }, options: null }, "process", "poll"],
  [{ source: { type: "file", path: "/tmp/job.log", tailLines: 20 }, options: null }, "file", "file"],
  [{ source: { type: "ssh", host: "worker", command: "tail -n5 /tmp/job.log", intervalSeconds: 30 }, options: null }, "ssh", "poll"],
  [{ source: { type: "http", url: "https://ci.example/run/1", method: "HEAD", intervalSeconds: 30 }, options: null }, "http", "poll"],
];
for (const [args, sourceType, mode] of cases) {
  const value = prepared(args);
  const resolved = resolveMonitorInput(value, "/tmp");
  assert.equal(resolved.sourceType, sourceType);
  if (mode === "file") assert.ok(resolved.config.logFile || resolved.config.probe?.type === "file");
  else if (sourceType === "poll") assert.equal(resolved.config.command, args.source.command);
  else assert.equal(resolved.config.probe?.type, sourceType);
}

// Every discriminator stays authoritative even when a strict decoder invents
// non-null alternatives. Only type-relevant fields reach WatcherConfig.
const strictBase = {
  command: "printf generated",
  path: "/tmp/generated.log",
  processBy: "pidFile",
  pidFile: "/tmp/generated.pid",
  match: "generated-match",
  host: "generated.invalid",
  url: "http://localhost",
  method: "GET",
  tailLines: 20,
  intervalSeconds: 5,
};
const strictTypes = [
  ["poll", (config) => config.command === "printf generated" && !config.probe && !config.logFile],
  ["tail", (config) => config.logFile === "/tmp/generated.log" && !config.command && !config.probe],
  ["process", (config) => config.probe?.type === "process" && config.probe.pidFile === "/tmp/generated.pid" && !config.probe.match],
  ["file", (config) => config.probe?.type === "file" && config.probe.path === "/tmp/generated.log"],
  ["ssh", (config) => config.probe?.type === "ssh" && config.probe.host === "generated.invalid"],
  ["http", (config) => config.probe?.type === "http" && config.probe.url === "http://localhost"],
];
for (const [type, check] of strictTypes) {
  const resolved = resolveMonitorInput(prepared({ source: { type, ...strictBase }, options: null }), "/tmp");
  assert.ok(check(resolved.config), `${type}: ${JSON.stringify(resolved)}`);
  assert.ok(resolved.ignoredSourceFields.length > 0, type);
}

// Exact fornace-max failure class: strict decoding filled every source slot.
// source.type is authoritative, so synthetic alternatives are ignored safely.
const strictGenerated = prepared({
  source: {
    type: "spawn",
    command: "printf 'monitor-shape-ok\\n'",
    path: "/tmp/generated.log",
    processBy: "pidFile",
    pidFile: "/tmp/generated.pid",
    match: "generated-placeholder",
    host: "generated.invalid",
    url: "http://localhost",
    method: "GET",
    tailLines: 20,
    intervalSeconds: 5,
  },
  options: null,
});
const launched = await monitor.execute("id", strictGenerated, undefined, undefined, ctx);
assert.equal(launched.details.action, "created");
assert.equal(launched.details.watcher.mode, "spawn");
assert.deepEqual(launched.details.ignoredSourceFields, [
  "path", "processBy", "pidFile", "match", "host", "url", "method", "tailLines", "intervalSeconds",
]);
assert.match(launched.content[0].text, /Ignored unrelated source fields/);
const id = launched.details.watcher.id;
const inspected = await inspect.execute("id", { id }, undefined, undefined, ctx);
assert.equal(inspected.details.watcher.logicalId, launched.details.watcher.logicalId);
await new Promise((resolve) => setTimeout(resolve, 250));
assert.ok(sent.some((message) => /PROCESS EXITED/.test(message.content)));

// Helpful semantic errors name the selected mode, missing field, and a valid example.
await assert.rejects(
  monitor.execute("id", prepared({ source: { type: "spawn" }, options: null }), undefined, undefined, ctx),
  /source\.type="spawn" requires source\.command.*Example:/,
);
await assert.rejects(
  monitor.execute("id", prepared({ source: { type: "process" }, options: null }), undefined, undefined, ctx),
  /requires source\.processBy="pidFile" or "match".*Example:/,
);
assert.throws(
  () => monitor.prepareArguments({
    command: "echo one",
    logFile: "",
    probe: { type: "http", url: "http://localhost", method: "GET" },
    intervalSeconds: 5,
  }),
  /known 2\.0\.1 strict-schema payload.*Use source\.type.*"type":"poll"/,
);
assert.throws(
  () => monitor.prepareArguments({ command: "echo one", logFile: "/tmp/two" }),
  /conflicting legacy sources: command, logFile.*Use source\.type/,
);
assert.throws(
  () => monitor.prepareArguments({}),
  /needs one explicit source.*Examples:/,
);

// Explicit local polling is preserved and still fails closed into quarantine.
const unsafe = await monitor.execute("id", prepared({
  source: { type: "poll", command: "python train.py", intervalSeconds: 30 },
  options: { recoveryPolicy: "confirm" },
}), undefined, undefined, ctx);
assert.equal(unsafe.details.action, "quarantined");
assert.equal(unsafe.details.watcher.state, "quarantined");
await kill.execute("id", { id: unsafe.details.watcher.id }, undefined, undefined, ctx);
const current = await status.execute("id", {}, undefined, undefined, ctx);
assert.equal(current.details.watchers.length, 0);

await events.session_shutdown({}, ctx);
console.log("✓ extension load/runtime smoke passed");
