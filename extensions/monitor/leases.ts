import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { OwnerRecord } from "./types.ts";

const DEFAULT_LEASE_MS = 45_000;

export interface LeaseValidation {
  alive: boolean;
  sameBoot: boolean;
  sameProcessStart: boolean;
  reason: string;
}

export interface LeaseClaim {
  acquired: boolean;
  owner?: OwnerRecord;
  existing?: OwnerRecord;
  staleArchived?: string;
  reason: string;
}

export interface LeaseEnvironment {
  now: () => number;
  pidAlive: (pid: number) => boolean;
  bootId: () => string;
  processStart: (pid: number) => string | undefined;
}

function execText(command: string): string | undefined {
  try {
    return readFileSync(command, "utf8").toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

export function hostBootId(): string {
  const linux = execText("/proc/sys/kernel/random/boot_id");
  if (linux) return linux;
  try {
    const raw = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 1000 }).trim();
    return raw || `unknown-${process.platform}`;
  } catch {
    return `unknown-${process.platform}`;
  }
}

export function processStartTime(pid: number): string | undefined {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000 }).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export const defaultLeaseEnvironment: LeaseEnvironment = {
  now: Date.now,
  pidAlive: isPidAlive,
  bootId: hostBootId,
  processStart: processStartTime,
};

export function leaseRoot(agentDir = join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "state", "pi-process-monitor");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

export function leasePath(root: string, sessionId: string, logicalId: string): string {
  return join(root, safeSegment(sessionId), `${safeSegment(logicalId)}.lease`);
}

async function readOwner(path: string): Promise<OwnerRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as OwnerRecord;
    if (!value || typeof value.runtimeId !== "string" || typeof value.pid !== "number"
      || typeof value.bootId !== "string" || typeof value.processStart !== "string"
      || typeof value.leaseUntil !== "string" || typeof value.ownerEpoch !== "string") return undefined;
    return value;
  } catch { return undefined; }
}

export function validateOwner(owner: OwnerRecord, env = defaultLeaseEnvironment): LeaseValidation {
  const sameBoot = owner.bootId === env.bootId();
  const alive = sameBoot && env.pidAlive(owner.pid);
  const currentStart = alive ? env.processStart(owner.pid) : undefined;
  const sameProcessStart = Boolean(currentStart && currentStart === owner.processStart);
  const expired = Date.parse(owner.leaseUntil) <= env.now();
  if (!sameBoot) return { alive: false, sameBoot, sameProcessStart: false, reason: "different boot" };
  if (!alive) return { alive: false, sameBoot, sameProcessStart: false, reason: "pid dead" };
  if (!sameProcessStart) return { alive: false, sameBoot, sameProcessStart, reason: "pid reused or start unavailable" };
  if (expired) return { alive: true, sameBoot, sameProcessStart, reason: "lease expired but owner still live" };
  return { alive: true, sameBoot, sameProcessStart, reason: "live owner" };
}

export function makeOwner(runtimeId: string, leaseMs = DEFAULT_LEASE_MS, env = defaultLeaseEnvironment): OwnerRecord {
  const start = env.processStart(process.pid);
  if (!start) throw new Error(`cannot establish process start time for pid ${process.pid}`);
  return {
    runtimeId,
    ownerEpoch: randomUUID(),
    pid: process.pid,
    bootId: env.bootId(),
    processStart: start,
    leaseUntil: new Date(env.now() + leaseMs).toISOString(),
  };
}

async function archiveStale(path: string, now: number): Promise<string | undefined> {
  const archive = `${path}.orphan-${now}`;
  try { await rename(path, archive); return archive; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acquireLease(
  path: string, owner: OwnerRecord, env = defaultLeaseEnvironment,
): Promise<LeaseClaim> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      return { acquired: true, owner, reason: "atomic lease acquired" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readOwner(path);
      if (existing) {
        const validation = validateOwner(existing, env);
        if (validation.alive) return { acquired: false, existing, reason: validation.reason };
      }
      const archived = await archiveStale(path, env.now());
      if (!archived) continue;
      if (attempt === 3) return { acquired: false, existing, staleArchived: archived, reason: "stale lease race exhausted" };
      try {
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        return { acquired: true, owner, staleArchived: archived, reason: "stale lease reclaimed" };
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
      }
    }
  }
  return { acquired: false, reason: "lease race exhausted" };
}

export async function renewLease(path: string, owner: OwnerRecord, leaseMs = DEFAULT_LEASE_MS, env = defaultLeaseEnvironment): Promise<OwnerRecord> {
  const current = await readOwner(path);
  if (!current || current.ownerEpoch !== owner.ownerEpoch) throw new Error("lease ownership changed");
  const renewed = { ...owner, leaseUntil: new Date(env.now() + leaseMs).toISOString() };
  const temp = `${path}.${owner.ownerEpoch}.tmp`;
  await writeFile(temp, `${JSON.stringify(renewed)}\n`, { mode: 0o600 });
  await rename(temp, path);
  return renewed;
}

export async function releaseLease(path: string, owner: OwnerRecord): Promise<boolean> {
  const current = await readOwner(path);
  if (!current || current.ownerEpoch !== owner.ownerEpoch) return false;
  try { await rm(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

export async function gcLeaseFile(path: string, env = defaultLeaseEnvironment): Promise<"live" | "removed" | "corrupt" | "missing"> {
  let info;
  try { info = await stat(path); }
  catch { return "missing"; }
  if (!info.isFile()) return "corrupt";
  const owner = await readOwner(path);
  if (!owner) {
    await archiveStale(path, env.now());
    return "corrupt";
  }
  if (validateOwner(owner, env).alive) return "live";
  await archiveStale(path, env.now());
  return "removed";
}
