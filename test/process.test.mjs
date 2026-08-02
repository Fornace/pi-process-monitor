import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOwned, stopOwned } from "../extensions/monitor/process.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await wait(25);
  }
  throw new Error("condition timed out");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

test("owned process group teardown kills shell and grandchild", async () => {
  if (process.platform === "win32") return test.skip("POSIX process groups required");
  const root = await mkdtemp(join(tmpdir(), "monitor-process-"));
  const pidFile = join(root, "grandchild.pid");
  try {
    const owned = spawnOwned({
      logicalId: "tree", ownerEpoch: "epoch", cwd: root,
      command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
    });
    const grandchild = await eventually(async () => {
      try { return Number((await readFile(pidFile, "utf8")).trim()) || undefined; } catch { return undefined; }
    });
    assert.equal(alive(grandchild), true);
    const receipt = await stopOwned(owned, { termGraceMs: 300, killGraceMs: 1000 });
    await eventually(() => !alive(grandchild));
    assert.equal(receipt.cleanupVerified, true);
    assert.ok(receipt.termSentAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SIGTERM-ignoring child escalates to SIGKILL with receipt", async () => {
  if (process.platform === "win32") return test.skip("POSIX signals required");
  const owned = spawnOwned({
    logicalId: "ignore", ownerEpoch: "epoch", cwd: "/tmp",
    command: `trap '' TERM; while :; do sleep 1; done`,
  });
  await wait(100);
  const receipt = await stopOwned(owned, { termGraceMs: 100, killGraceMs: 1000 });
  assert.ok(receipt.termSentAt);
  assert.ok(receipt.killSentAt);
  assert.equal(receipt.cleanupVerified, true);
});

test("stdout and stderr caps produce truncation receipts", async () => {
  const owned = spawnOwned({
    logicalId: "caps", ownerEpoch: "epoch", cwd: "/tmp",
    command: `python3 -c "import sys; print('x'*5000); print('y'*5000,file=sys.stderr)"`,
    stdoutByteCap: 1024, stderrByteCap: 1024,
  });
  await new Promise((resolve, reject) => {
    owned.child.once("exit", resolve);
    owned.child.once("error", reject);
  });
  assert.ok(owned.receipt.stdoutTruncatedBytes > 0);
  assert.ok(owned.receipt.stderrTruncatedBytes > 0);
});
