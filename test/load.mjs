// typecheck happens via `npm run typecheck` (tsc). This is a runtime smoke test:
// loads the extension against a stub ExtensionAPI, asserts 3 tools + 3 commands
// register, exercises status/start/kill, and verifies teardown is clean.
const tools = [];
const commands = [];
const events = {};
const sent = [];
const entries = [];
const pi = {
  on: (e, h) => { events[e] = h; },
  registerTool: (d) => { tools.push(d); },
  registerCommand: (n, o) => { commands.push({ name: n, ...o }); },
  registerMessageRenderer: () => {},
  sendMessage: (m, _o) => { sent.push(m); },
  appendEntry: (t, d) => { entries.push({ type: "custom", customType: t, data: d }); },
};
const smEntries = () => entries;
const fakeCtx = (cwd = "/tmp") => ({ cwd, ui: { notify: () => {}, confirm: async () => true, input: async () => "", select: async () => undefined } });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error("  ✗", m); } };

const { default: factory } = await import("../extensions/monitor.ts");
factory(pi);

console.log("tools:", tools.map(t => t.name).sort().join(", "));
console.log("commands:", commands.map(c => c.name).sort().join(", "));
ok(tools.length === 3 && ["monitor", "monitor_kill", "monitor_status"].every(n => tools.some(t => t.name === n)), "3 tools registered");
ok(commands.length === 3 && ["monitor", "monitors", "monitor-kill"].every(n => commands.some(c => c.name === n)), "3 commands registered");
ok(typeof commands.find(c => c.name === "monitor-kill").getArgumentCompletions === "function", "monitor-kill has autocomplete");

// status with no watchers
const status = tools.find(t => t.name === "monitor_status");
const r0 = await status.execute("c", {}, new AbortController().signal, undefined, fakeCtx());
ok(r0.content[0].text === "No watchers.", "status empty = 'No watchers.'");

// start a spawn watcher
const mon = tools.find(t => t.name === "monitor");
const r1 = await mon.execute("c", { command: "for i in 1 2 3; do echo step $i; sleep 0.03; done; echo DONE-success", coalesceSeconds: 0 }, new AbortController().signal, undefined, fakeCtx());
const wid = r1.details.watcher.id;
ok(r1.details.watcher.mode === "spawn" && wid.length >= 6, "started a spawn watcher");

// autocomplete now returns the live id
const killCmd = commands.find(c => c.name === "monitor-kill");
const ac = killCmd.getArgumentCompletions(wid.slice(0, 3));
ok(ac && ac.some(i => i.value === wid), "autocomplete returns live watcher id");

// let it run + flush the exit message
await new Promise(res => setTimeout(res, 500));
const exitMsg = sent.find(m => /PROCESS EXITED \(code=0/.test(m.content || ""));
ok(exitMsg, "exit pinged (PROCESS EXITED present in messages)");

// session_start resume: append a poll-watcher entry, then re-fire session_start
entries.push({ type: "custom", customType: "monitor-watcher", data: { command: "echo hi", intervalSec: 60, cwd: "/tmp" } });
await events["session_start"]?.({}, { sessionManager: { getEntries: smEntries }, ...fakeCtx() });
ok([...tools].length === 3, "resume did not re-register tools");
// (the resumed watcher launches via the closure; just assert no throw)

// teardown
events["session_shutdown"]?.();
ok(true, "session_shutdown did not throw");

// kill on a non-existent id
const kill = tools.find(t => t.name === "monitor_kill");
const knf = await kill.execute("c", { id: "nope" }, new AbortController().signal, undefined, fakeCtx());
ok(knf.details.watcher === undefined, "kill(missing) returns undefined watcher");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
