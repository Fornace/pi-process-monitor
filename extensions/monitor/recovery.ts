import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RecoveryHistory {
  schemaVersion: 1;
  sessionId: string;
  cleanShutdownAt?: string;
  runtimeStartedAt?: string;
  abnormalStarts: string[];
}

export interface FuseDecision {
  quarantineLocalPolls: boolean;
  disableAllLocalRecovery: boolean;
  recent10m: number;
  recent30m: number;
}

function historyPath(root: string, sessionId: string): string {
  return join(root, sessionId.replace(/[^a-zA-Z0-9._-]/g, "_"), "recovery.json");
}

function load(path: string, sessionId: string): RecoveryHistory {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RecoveryHistory;
    if (value.schemaVersion === 1 && value.sessionId === sessionId && Array.isArray(value.abnormalStarts)) return value;
  } catch { /* fresh or corrupt history */ }
  return { schemaVersion: 1, sessionId, abnormalStarts: [] };
}

function atomicWrite(path: string, value: RecoveryHistory): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try { renameSync(temp, path); }
  catch { try { unlinkSync(temp); } catch { /* gone */ } }
}

export function recordRuntimeStart(root: string, sessionId: string, now = Date.now()): RecoveryHistory {
  const path = historyPath(root, sessionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = load(path, sessionId);
  if (existsSync(path) && value.runtimeStartedAt
    && (!value.cleanShutdownAt || Date.parse(value.cleanShutdownAt) < Date.parse(value.runtimeStartedAt))) {
    value.abnormalStarts.push(new Date(now).toISOString());
  }
  value.runtimeStartedAt = new Date(now).toISOString();
  value.abnormalStarts = value.abnormalStarts.filter((time) => Date.parse(time) >= now - 24 * 60 * 60 * 1000);
  atomicWrite(path, value);
  return value;
}

export function recordCleanShutdown(root: string, sessionId: string, now = Date.now()): void {
  const path = historyPath(root, sessionId);
  const value = load(path, sessionId);
  value.cleanShutdownAt = new Date(now).toISOString();
  value.abnormalStarts = value.abnormalStarts.filter((time) => Date.parse(time) >= now - 30 * 60 * 1000);
  atomicWrite(path, value);
}

export function evaluateFuse(history: RecoveryHistory, now = Date.now()): FuseDecision {
  const recent10m = history.abnormalStarts.filter((time) => Date.parse(time) >= now - 10 * 60 * 1000).length;
  const recent30m = history.abnormalStarts.filter((time) => Date.parse(time) >= now - 30 * 60 * 1000).length;
  return {
    quarantineLocalPolls: recent10m >= 2,
    disableAllLocalRecovery: recent30m >= 3,
    recent10m,
    recent30m,
  };
}

export function clearFuse(root: string, sessionId: string): void {
  const path = historyPath(root, sessionId);
  const value = load(path, sessionId);
  value.abnormalStarts = [];
  value.cleanShutdownAt = new Date().toISOString();
  atomicWrite(path, value);
}
