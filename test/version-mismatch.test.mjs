import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoPackage = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const installedPackagePath = resolve(process.env.HOME, ".pi", "agent", "npm", "node_modules", "pi-process-monitor", "package.json");
let installedPackage;
try { installedPackage = JSON.parse(await readFile(installedPackagePath, "utf8")); } catch { installedPackage = null; }

test("repository package version is captured", () => {
  assert.equal(repoPackage.version, "2.0.1");
});

test("Pi-managed legacy install mismatch is captured when present", async () => {
  if (!installedPackage) return;
  assert.notEqual(installedPackage.version, repoPackage.version);
  assert.match(installedPackage.version, /^1\.[12]\.0$/);
});

test("brief-specified installed 1.2.0 fixture reproduces getEntries append-on-resume", async () => {
  const source = await readFile(resolve("test/fixtures/legacy-installed-monitor.ts"), "utf8");
  assert.match(source, /installedVersion = "1\.2\.0"/);
  assert.match(source, /getEntries\(\)/);
  assert.match(source, /appendEntry\("monitor-watcher"/);
});

test("legacy installed package retains unsafe append-on-resume implementation shape when present", async () => {
  const sourcePath = resolve(installedPackagePath, "..", "extensions", "monitor.ts");
  try { await access(sourcePath); } catch { return; }
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /getEntries\(\)/);
  assert.match(source, /appendEntry\("monitor-watcher"/);
  assert.doesNotMatch(source, /getBranch\(\)/);
});
