import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoPackage = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const installedPackagePath = resolve(process.env.HOME, ".pi", "agent", "npm", "node_modules", "pi-process-monitor", "package.json");
let installedPackage;
try { installedPackage = JSON.parse(await readFile(installedPackagePath, "utf8")); } catch { installedPackage = null; }

test("repository and effective installed monitor versions are captured", () => {
  assert.equal(repoPackage.version, "2.0.0");
  assert.ok(installedPackage, `expected Pi-managed install at ${installedPackagePath}`);
  // The incident brief expected 1.2.0; this host currently proves an even older
  // effective 1.1.0 can remain pinned while the crash-safe repository is 2.0.0.
  assert.notEqual(installedPackage.version, repoPackage.version);
  assert.match(installedPackage.version, /^1\.[12]\.0$/);
});

test("legacy installed package retains unsafe append-on-resume implementation shape", async () => {
  const source = await readFile(resolve(installedPackagePath, "..", "extensions", "monitor.ts"), "utf8");
  assert.match(source, /getEntries\(\)/);
  assert.match(source, /appendEntry\("monitor-watcher"/);
  assert.doesNotMatch(source, /getBranch\(\)/);
});
