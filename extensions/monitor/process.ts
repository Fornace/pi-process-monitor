import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { sha256 } from "./identity.ts";
import { hostBootId, processStartTime } from "./leases.ts";
import type { ProcessReceipt } from "./types.ts";

export interface OwnedProcess {
  child: ChildProcess;
  receipt: ProcessReceipt;
}

export interface SpawnOwnedOptions {
  logicalId: string;
  ownerEpoch: string;
  command: string;
  cwd: string;
  stdoutByteCap?: number;
  stderrByteCap?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

function displayCommand(command: string): string {
  return command.length <= 300 ? command : `${command.slice(0, 297)}...`;
}

function pgidFor(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 1000 }).trim();
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch { return undefined; }
}

function groupAlive(pgid: number | undefined, pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(process.platform === "win32" || !pgid ? pid : -pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalOwned(receipt: ProcessReceipt, signal: NodeJS.Signals): boolean {
  if (!receipt.pid) return false;
  try {
    process.kill(process.platform === "win32" || !receipt.pgid ? receipt.pid : -receipt.pgid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function capChunk(chunk: Buffer, remaining: number): { accepted: Buffer; truncated: number } {
  if (remaining <= 0) return { accepted: Buffer.alloc(0), truncated: chunk.length };
  if (chunk.length <= remaining) return { accepted: chunk, truncated: 0 };
  return { accepted: chunk.subarray(0, remaining), truncated: chunk.length - remaining };
}

export function spawnOwned(options: SpawnOwnedOptions): OwnedProcess {
  const stdoutCap = Math.max(1024, options.stdoutByteCap ?? 128 * 1024);
  const stderrCap = Math.max(1024, options.stderrByteCap ?? 128 * 1024);
  const child = spawn("bash", ["-c", options.command], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startedAt = new Date().toISOString();
  const receipt: ProcessReceipt = {
    logicalId: options.logicalId,
    ownerEpoch: options.ownerEpoch,
    commandHash: sha256(options.command),
    displayCommand: displayCommand(options.command),
    cwd: options.cwd,
    pid: child.pid,
    pgid: child.pid ? pgidFor(child.pid) ?? (process.platform !== "win32" ? child.pid : undefined) : undefined,
    parentPid: process.pid,
    bootId: hostBootId(),
    processStart: child.pid ? processStartTime(child.pid) : undefined,
    startedAt,
    stdoutTruncatedBytes: 0,
    stderrTruncatedBytes: 0,
  };
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const capped = capChunk(chunk, stdoutCap - stdoutBytes);
    stdoutBytes += capped.accepted.length;
    receipt.stdoutTruncatedBytes += capped.truncated;
    if (capped.accepted.length) options.onStdout?.(capped.accepted);
  });
  child.stderr?.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const capped = capChunk(chunk, stderrCap - stderrBytes);
    stderrBytes += capped.accepted.length;
    receipt.stderrTruncatedBytes += capped.truncated;
    if (capped.accepted.length) options.onStderr?.(capped.accepted);
  });
  child.once("exit", (code, signal) => {
    receipt.exitedAt = new Date().toISOString();
    receipt.exitCode = code;
    receipt.signal = signal;
    receipt.cleanupVerified = !groupAlive(receipt.pgid, receipt.pid);
  });
  return { child, receipt };
}

export interface StopOptions {
  termGraceMs?: number;
  killGraceMs?: number;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

export async function stopOwned(owned: OwnedProcess, options: StopOptions = {}): Promise<ProcessReceipt> {
  const { child, receipt } = owned;
  const termGrace = options.termGraceMs ?? 3000;
  const killGrace = options.killGraceMs ?? 2000;
  if (!groupAlive(receipt.pgid, receipt.pid)) {
    receipt.cleanupVerified = true;
    return receipt;
  }
  receipt.termSentAt = new Date().toISOString();
  signalOwned(receipt, "SIGTERM");
  await waitForExit(child, termGrace);
  if (groupAlive(receipt.pgid, receipt.pid)) {
    receipt.killSentAt = new Date().toISOString();
    signalOwned(receipt, "SIGKILL");
    await waitForExit(child, killGrace);
  }
  receipt.cleanupVerified = !groupAlive(receipt.pgid, receipt.pid);
  return receipt;
}

export function ownedProcessAlive(receipt: ProcessReceipt): boolean {
  if (!receipt.pid || !receipt.processStart) return false;
  return receipt.bootId === hostBootId()
    && receipt.processStart === processStartTime(receipt.pid)
    && groupAlive(receipt.pgid, receipt.pid);
}
