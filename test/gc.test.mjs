import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planExternalGc } from "../extensions/monitor/gc.ts";

test("monitor GC dry-run is non-mutating and apply archives corrupt lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-gc-"));
  const path = join(root, "bad.lease");
  try {
    await writeFile(path, "bad-json\n");
    const dry = await planExternalGc(root, false);
    assert.deepEqual(dry.corrupt, [path]);
    assert.deepEqual((await readdir(root)).sort(), ["bad.lease"]);
    const applied = await planExternalGc(root, true);
    assert.deepEqual(applied.corrupt, [path]);
    const files = await readdir(root);
    assert.equal(files.includes("bad.lease"), false);
    assert.ok(files.some((name) => name.startsWith("bad.lease.orphan-")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
