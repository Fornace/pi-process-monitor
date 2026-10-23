import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LeaseDiskSnapshot, LeaseFailureSnapshot, OwnerRecord } from "./types.ts";

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
    if (raw) return raw;
  } catch { /* unsupported platform */ }
  throw new Error(`host boot identity unavailable on ${process.platform}`);
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

const pathLocks = new Map<string, Promise<unknown>>();

function withLeasePathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tracked = next.then(
    () => { if (pathLocks.get(path) === tracked) pathLocks.delete(path); },
    () => { if (pathLocks.get(path) === tracked) pathLocks.delete(path); },
  );
  pathLocks.set(path, tracked);
  return next;
}

function parseOwnerRecord(raw: string): OwnerRecord | undefined {
  try {
    const value = JSON.parse(raw) as OwnerRecord;
    if (!value || typeof value.runtimeId !== "string" || typeof value.pid !== "number"
      || typeof value.bootId !== "string" || typeof value.processStart !== "string"
      || typeof value.leaseUntil !== "string" || typeof value.ownerEpoch !== "string") return undefined;
    return value;
  } catch { return undefined; }
}

async function readOwner(path: string): Promise<OwnerRecord | undefined> {
  try {
    return parseOwnerRecord(await readFile(path, "utf8"));
  } catch { return undefined; }
}

export async function readLeaseDiskSnapshot(path: string): Promise<LeaseDiskSnapshot> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false };
    return { exists: false, readError: `${code ?? "ERR"}: ${(error as Error).message}` };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsedOwner = parseOwnerRecord(raw) ?? null;
    return {
      exists: true,
      ino: info.ino,
      size: info.size,
      mtime: info.mtime.toISOString(),
      raw: raw.slice(0, 1024),
      parsedOwner,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      exists: true,
      ino: info.ino,
      size: info.size,
      mtime: info.mtime.toISOString(),
      readError: `${code ?? "ERR"}: ${(error as Error).message}`,
    };
  }
}

export class LeaseRenewalError extends Error {
  readonly snapshot: LeaseFailureSnapshot;
  readonly code?: string;

  constructor(message: string, snapshot: LeaseFailureSnapshot) {
    super(message);
    this.name = "LeaseRenewalError";
    this.snapshot = snapshot;
    this.code = snapshot.code;
  }
}

export async function captureLeaseFailure(
  path: string,
  expectedOwner: OwnerRecord,
  error: unknown,
  now = Date.now(),
): Promise<LeaseFailureSnapshot> {
  if (error instanceof LeaseRenewalError) return structuredClone(error.snapshot);
  const disk = await readLeaseDiskSnapshot(path);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return {
    failedAt: new Date(now).toISOString(),
    stage: "verify",
    error: message,
    code,
    leasePath: path,
    expectedOwner: structuredClone(expectedOwner),
    disk,
  };
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

async function writeExclusiveLease(path: string, owner: OwnerRecord): Promise<void> {
  const stage = `${path}.stage-${process.pid}-${randomUUID()}`;
  const handle = await open(stage, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(stage, path);
  } finally {
    await unlink(stage).catch(() => {});
  }
}

export async function acquireLease(
  path: string, owner: OwnerRecord, env = defaultLeaseEnvironment,
): Promise<LeaseClaim> {
  return withLeasePathLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await writeExclusiveLease(path, owner);
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
          await writeExclusiveLease(path, owner);
          return { acquired: true, owner, staleArchived: archived, reason: "stale lease reclaimed" };
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
        }
      }
    }
    return { acquired: false, reason: "lease race exhausted" };
  });
}

function describeDiskMismatch(expected: OwnerRecord, disk: LeaseDiskSnapshot, prefix: string): string {
  if (!disk.exists) return `${prefix}: lease file missing${disk.readError ? ` (${disk.readError})` : ""}`;
  if (disk.parsedOwner) {
    return `${prefix}: expected epoch ${expected.ownerEpoch}, found ${disk.parsedOwner.ownerEpoch} (pid=${disk.parsedOwner.pid}, runtime=${disk.parsedOwner.runtimeId})`;
  }
  return `${prefix}: invalid lease record (size=${disk.size ?? "unknown"}${disk.readError ? `, ${disk.readError}` : ""})`;
}

export async function renewLease(path: string, owner: OwnerRecord, leaseMs = DEFAULT_LEASE_MS, env = defaultLeaseEnvironment): Promise<OwnerRecord> {
  return withLeasePathLock(path, async () => {
    const preDisk = await readLeaseDiskSnapshot(path);
    if (!preDisk.parsedOwner || preDisk.parsedOwner.ownerEpoch !== owner.ownerEpoch) {
      const message = describeDiskMismatch(owner, preDisk, "lease ownership changed");
      throw new LeaseRenewalError(message, {
        failedAt: new Date(env.now()).toISOString(),
        stage: "precheck",
        error: message,
        leasePath: path,
        expectedOwner: structuredClone(owner),
        disk: preDisk,
      });
    }
    const renewed = { ...owner, leaseUntil: new Date(env.now() + leaseMs).toISOString() };
    const payload = Buffer.from(`${JSON.stringify(renewed)}\n`, "utf8");
    // Write through the already-open lease inode at offset 0 BEFORE truncating to
    // payload.length so the file is never 0 bytes on disk during renewal.
    let handle;
    try {
      handle = await open(path, "r+");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const disk = await readLeaseDiskSnapshot(path);
      const message = `lease ownership changed: open failed (${code ?? (error as Error).message})`;
      throw new LeaseRenewalError(message, {
        failedAt: new Date(env.now()).toISOString(),
        stage: "open",
        error: message,
        code,
        leasePath: path,
        expectedOwner: structuredClone(owner),
        disk,
      });
    }
    try {
      const info = await handle.stat();
      const raw = await handle.readFile("utf8");
      const verified = parseOwnerRecord(raw);
      if (!verified || verified.ownerEpoch !== owner.ownerEpoch) {
        const disk: LeaseDiskSnapshot = {
          exists: true,
          ino: info.ino,
          size: info.size,
          mtime: info.mtime.toISOString(),
          raw: raw.slice(0, 1024),
          parsedOwner: verified ?? null,
        };
        const message = describeDiskMismatch(owner, disk, "lease ownership changed");
        throw new LeaseRenewalError(message, {
          failedAt: new Date(env.now()).toISOString(),
          stage: "verify",
          error: message,
          leasePath: path,
          expectedOwner: structuredClone(owner),
          disk,
        });
      }
      try {
        await handle.write(payload, 0, payload.length, 0);
        await handle.truncate(payload.length);
        await handle.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = `lease renewal write failed (${code ?? (error as Error).message})`;
        throw new LeaseRenewalError(message, {
          failedAt: new Date(env.now()).toISOString(),
          stage: "write",
          error: message,
          code,
          leasePath: path,
          expectedOwner: structuredClone(owner),
          disk: {
            exists: true,
            ino: info.ino,
            size: info.size,
            mtime: info.mtime.toISOString(),
            raw: raw.slice(0, 1024),
            parsedOwner: verified,
          },
        });
      }
    } finally { await handle.close(); }
    const afterDisk = await readLeaseDiskSnapshot(path);
    if (!afterDisk.parsedOwner || afterDisk.parsedOwner.ownerEpoch !== owner.ownerEpoch) {
      const message = describeDiskMismatch(owner, afterDisk, "lease ownership changed during renewal");
      throw new LeaseRenewalError(message, {
        failedAt: new Date(env.now()).toISOString(),
        stage: "postcheck",
        error: message,
        leasePath: path,
        expectedOwner: structuredClone(owner),
        disk: afterDisk,
      });
    }
    return renewed;
  });
}

export async function releaseLease(path: string, owner: OwnerRecord): Promise<boolean> {
  return withLeasePathLock(path, async () => {
    const current = await readOwner(path);
    if (!current || current.ownerEpoch !== owner.ownerEpoch) return false;
    const archive = `${path}.release-${owner.ownerEpoch}`;
    try { await rename(path, archive); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    const moved = await readOwner(archive);
    if (!moved || moved.ownerEpoch !== owner.ownerEpoch) {
      // A different inode won the path race. Restore only if the lease path is free.
      try { await rename(archive, path); } catch { /* preserve foreign archive */ }
      return false;
    }
    await rm(archive, { force: true });
    return true;
  });
}

export async function inspectLeaseFile(path: string, env = defaultLeaseEnvironment): Promise<"live" | "stale" | "corrupt" | "missing"> {
  let info;
  try { info = await stat(path); }
  catch { return "missing"; }
  if (!info.isFile()) return "corrupt";
  const owner = await readOwner(path);
  if (!owner) return "corrupt";
  return validateOwner(owner, env).alive ? "live" : "stale";
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
