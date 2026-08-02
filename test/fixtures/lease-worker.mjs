import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { acquireLease } from "../../extensions/monitor/leases.ts";

const [path, epoch, barrier] = process.argv.slice(2);
while (!readFileSync(barrier, "utf8").includes("go")) await new Promise((resolve) => setTimeout(resolve, 2));
const processStart = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || undefined; }
  catch { return undefined; }
};
const selfStart = processStart(process.pid);
const owner = {
  runtimeId: `runtime-${epoch}`, ownerEpoch: epoch, pid: process.pid,
  bootId: "test-boot", processStart: selfStart,
  leaseUntil: new Date(Date.now() + 60_000).toISOString(),
};
const env = {
  now: Date.now,
  pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  bootId: () => "test-boot",
  processStart,
};
const claim = await acquireLease(path, owner, env);
process.stdout.write(JSON.stringify({ acquired: claim.acquired, epoch, existing: claim.existing?.ownerEpoch }));
await new Promise((resolve) => setTimeout(resolve, 300));
