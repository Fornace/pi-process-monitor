import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = process.env.MONITOR_TEST_PROVIDER;
const model = process.env.MONITOR_TEST_MODEL;
if (!provider || !model) {
  console.log(`# test:real-pi skipped (set MONITOR_TEST_PROVIDER and MONITOR_TEST_MODEL to run a live provider call)`);
  process.exit(0);
}

const workDir = await mkdtemp(resolve(tmpdir(), "pi-process-monitor-real-pi-"));
const outPath = resolve(workDir, "real-pi.jsonl");
const errPath = resolve(workDir, "real-pi.err");
const args = [
  "--no-session", "-p", "--no-extensions", "-e", ".",
  "--no-skills", "--no-prompt-templates", "--no-context-files",
  "--no-builtin-tools", "--tools", "monitor", "--mode", "json",
  "--provider", provider,
  "--model", model,
  "Call monitor once with command 'printf schema-real-pi-ok' and label schema-real-pi. Omit every unused field. Report the result.",
];

const stdout = [];
const stderr = [];
const child = spawn("pi", args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));
child.on("error", (error) => child.kill?.());
const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
const code = await new Promise((resolveExit, rejectExit) => {
  child.on("exit", resolveExit);
  child.on("error", rejectExit);
});
clearTimeout(timeout);
await writeFile(outPath, Buffer.concat(stdout));
await writeFile(errPath, Buffer.concat(stderr));
try {
  assert.equal(code, 0, `real Pi exited ${code}; see ${errPath}`);

  const events = (await readFile(outPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const call = events.find((event) => event.type === "tool_execution_start" && event.toolName === "monitor");
  assert.ok(call, `missing monitor call; see ${outPath}`);
  assert.deepEqual(call.args, { command: "printf schema-real-pi-ok", label: "schema-real-pi" });
  const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === call.toolCallId);
  assert.equal(end?.isError, false, `monitor failed; see ${outPath}`);
  assert.equal(end?.result?.details?.watcher?.mode, "spawn");
  assert.ok(
    events.some((event) => event.type === "message_end" && event.message?.customType === "monitor" && /PROCESS EXITED \(code=0/.test(event.message.content)),
    `missing clean exit ping; see ${outPath}`,
  );
  console.log(`✓ real Pi provider call used one source and exited cleanly (${outPath})`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
