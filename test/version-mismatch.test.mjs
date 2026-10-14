import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("brief-specified installed 1.2.0 fixture reproduces getEntries append-on-resume", async () => {
  const source = await readFile(resolve("test/fixtures/legacy-installed-monitor.ts"), "utf8");
  assert.match(source, /installedVersion = "1\.2\.0"/);
  assert.match(source, /getEntries\(\)/);
  assert.match(source, /appendEntry\("monitor-watcher"/);
});
