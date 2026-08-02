import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { acquireLease, gcLeaseFile, releaseLease, renewLease, validateOwner } from "../extensions/monitor/leases.ts";

const execFileAsync = promisify(execFile);

function owner(epoch, overrides = {}) {
  return {
    runtimeId: `runtime-${epoch}`, ownerEpoch: epoch, pid: 42, bootId: "boot-a",
    processStart: "start-a", leaseUntil: "2026-08-02T10:01:00Z", ...overrides,
  };
}

function env(overrides = {}) {
  return {
    now: () => Date.parse("2026-08-02T10:00:00Z"),
    pidAlive: () => true,
    bootId: () => "boot-a",
    processStart: () => "start-a",
    ...overrides,
  };
}

test("atomic race yields exactly one lease owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-lease-"));
  const path = join(root, "watch.lease");
  try {
    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => acquireLease(path, owner(String(index)), env())));
    assert.equal(claims.filter((claim) => claim.acquired).length, 1);
    assert.equal(claims.filter((claim) => !claim.acquired && claim.existing).length, 19);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two independent Node processes racing one lease produce one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-lease-process-"));
  const path = join(root, "watch.lease");
  const barrier = join(root, "barrier");
  const worker = new URL("./fixtures/lease-worker.mjs", import.meta.url).pathname;
  try {
    await writeFile(barrier, "wait");
    const children = Array.from({ length: 8 }, (_, index) => spawn(process.execPath, [worker, path, String(index), barrier], { stdio: ["ignore", "pipe", "pipe"] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(barrier, "go");
    const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    })));
    assert.equal(results.filter((result) => result.acquired).length, 1);
    assert.equal(results.filter((result) => result.existing).length, 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale lease reclaimed only with boot, pid, and start validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-lease-"));
  const path = join(root, "watch.lease");
  try {
    await writeFile(path, `${JSON.stringify(owner("old"))}\n`);
    const live = await acquireLease(path, owner("new"), env());
    assert.equal(live.acquired, false);
    assert.equal(live.existing?.ownerEpoch, "old");
    const stale = await acquireLease(path, owner("new"), env({ processStart: () => "different-start" }));
    assert.equal(stale.acquired, true);
    assert.match(stale.staleArchived ?? "", /orphan/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lease renewal and release require matching owner epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-lease-"));
  const path = join(root, "watch.lease");
  try {
    const first = owner("first");
    assert.equal((await acquireLease(path, first, env())).acquired, true);
    await assert.rejects(() => renewLease(path, owner("other"), 45_000, env()), /ownership changed/);
    assert.equal(await releaseLease(path, owner("other")), false);
    assert.equal((await renewLease(path, first, 45_000, env())).ownerEpoch, "first");
    assert.equal(await releaseLease(path, first), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt lease is archived, never interpreted as a pid to kill", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-lease-"));
  const path = join(root, "watch.lease");
  try {
    await writeFile(path, "{not-json\n");
    assert.equal(await gcLeaseFile(path, env()), "corrupt");
    await assert.rejects(() => readFile(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner validation fails closed if process start cannot be established", () => {
  const result = validateOwner(owner("x"), env({ processStart: () => undefined }));
  assert.equal(result.alive, false);
  assert.match(result.reason, /start unavailable/);
});
