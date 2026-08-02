import { sha256, canonicalCommand, canonicalPath } from "./identity.ts";
import {
  LEGACY_CUSTOM_TYPE, NONTERMINAL_STATES, STATE_CUSTOM_TYPE, STATE_SCHEMA_VERSION,
  TERMINAL_STATES, type CheckpointData, type ReducedState, type SessionEntryLike,
  type WatcherConfig, type WatcherSnapshot, type WatcherStateEvent,
} from "./types.ts";

interface LegacyRecord {
  id?: string;
  command?: string;
  logFile?: string;
  intervalSec?: number;
  intervalSeconds?: number;
  cwd?: string;
  notifyOn?: string[];
  heartbeatMinutes?: number;
  coalesceSeconds?: number;
  maxLines?: number;
  timeoutSeconds?: number;
  stopped?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStateEvent(value: unknown): value is WatcherStateEvent {
  if (!isObject(value)) return false;
  return value.schemaVersion === STATE_SCHEMA_VERSION
    && typeof value.logicalId === "string"
    && Number.isInteger(value.revision) && Number(value.revision) > 0
    && typeof value.event === "string"
    && ["spawn", "poll", "file"].includes(String(value.mode))
    && typeof value.sourceFingerprint === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && ["never", "confirm", "safe-auto"].includes(String(value.recoveryPolicy));
}

function snapshotFromEvent(event: WatcherStateEvent): WatcherSnapshot | undefined {
  if (event.event === "checkpoint") return undefined;
  return {
    logicalId: event.logicalId,
    revision: event.revision,
    state: event.event,
    mode: event.mode,
    sourceFingerprint: event.sourceFingerprint,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    expiresAt: event.expiresAt,
    recoveryPolicy: event.recoveryPolicy,
    config: event.config,
    owner: event.owner,
    reason: event.reason,
  };
}

function validTransition(previous: WatcherSnapshot | undefined, event: WatcherStateEvent): boolean {
  if (!previous) return event.revision === 1 && event.event === "created";
  if (event.revision !== previous.revision + 1) return false;
  if (event.createdAt !== previous.createdAt || event.mode !== previous.mode) return false;
  if (TERMINAL_STATES.has(previous.state)) return false;
  const allowed: Record<string, Set<string>> = {
    created: new Set(["claimed", "quarantined", "stopped", "expired"]),
    claimed: new Set(["heartbeat", "released", "quarantined", "stopped", "expired"]),
    heartbeat: new Set(["heartbeat", "released", "quarantined", "stopped", "expired"]),
    released: new Set(["claimed", "quarantined", "stopped", "expired"]),
    quarantined: new Set(["claimed", "stopped", "expired"]),
  };
  return allowed[previous.state]?.has(event.event) ?? false;
}

function legacyKey(record: LegacyRecord): string | undefined {
  // Legacy runtime ids were unstable across recovery. Reduce by canonical source
  // so repeated append-on-resume records become one deterministic logical watcher.
  if (record.command) return `command:${canonicalCommand(record.command)}`;
  if (record.logFile) return `file:${canonicalPath(record.logFile, record.cwd ?? process.cwd())}`;
  if (record.id) return `id:${record.id}`;
  return undefined;
}

function legacySnapshot(record: LegacyRecord, entry: SessionEntryLike): WatcherSnapshot | undefined {
  const key = legacyKey(record);
  if (!key || (!record.command && !record.logFile)) return undefined;
  const createdAt = entry.timestamp ?? new Date(0).toISOString();
  const mode = record.logFile ? "file" : "poll";
  let expiresAt: string | undefined;
  if (record.timeoutSeconds && Date.parse(createdAt)) {
    expiresAt = new Date(Date.parse(createdAt) + record.timeoutSeconds * 1000).toISOString();
  }
  const config: WatcherConfig = {
    command: record.command,
    logFile: record.logFile,
    intervalSeconds: record.intervalSeconds ?? record.intervalSec,
    cwd: record.cwd ?? process.cwd(),
    notifyOn: record.notifyOn,
    heartbeatMinutes: record.heartbeatMinutes,
    coalesceSeconds: record.coalesceSeconds,
    maxLines: record.maxLines,
    expiresAt,
    recoveryPolicy: mode === "file" ? "safe-auto" : "confirm",
    reuse: "return-existing",
    safetyClass: mode === "poll" ? "unsafe-shell" : "auto",
  };
  return {
    logicalId: `legacy-${sha256(key).slice(0, 24)}`,
    revision: 1,
    state: record.stopped ? "stopped" : "released",
    mode,
    sourceFingerprint: sha256(JSON.stringify({ key, mode, cwd: config.cwd })),
    createdAt,
    updatedAt: entry.timestamp ?? createdAt,
    expiresAt,
    recoveryPolicy: config.recoveryPolicy,
    config,
    legacy: true,
    reason: expiresAt ? "migrated legacy relative timeout" : "migrated legacy record",
  };
}

function applyCheckpoint(result: ReducedState, event: WatcherStateEvent, entryId?: string): void {
  const checkpoint = event.checkpoint;
  if (!checkpoint || !Array.isArray(checkpoint.active) || !Array.isArray(checkpoint.recentTerminal)) {
    result.malformed++;
    return;
  }
  result.watchers.clear();
  for (const snapshot of [...checkpoint.active, ...checkpoint.recentTerminal]) {
    if (!snapshot?.logicalId || !snapshot.state || !Number.isInteger(snapshot.revision)) {
      result.malformed++;
      continue;
    }
    result.watchers.set(snapshot.logicalId, snapshot);
  }
  result.checkpointEntryId = entryId;
}

export function reduceState(entries: SessionEntryLike[], now = Date.now()): ReducedState {
  const result: ReducedState = {
    watchers: new Map(), quarantined: [], malformed: 0, ignored: 0, migratedLegacy: 0,
  };
  const legacy = new Map<string, { record: LegacyRecord; entry: SessionEntryLike }>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === LEGACY_CUSTOM_TYPE) {
      if (!isObject(entry.data)) { result.malformed++; continue; }
      const record = entry.data as LegacyRecord;
      const key = legacyKey(record);
      if (key) legacy.set(key, { record, entry });
      else result.malformed++;
      continue;
    }
    if (entry.customType !== STATE_CUSTOM_TYPE) continue;
    if (!isObject(entry.data)) { result.malformed++; continue; }
    if (entry.data.schemaVersion !== STATE_SCHEMA_VERSION) {
      result.malformed++;
      continue;
    }
    if (!isStateEvent(entry.data)) { result.malformed++; continue; }
    const event = entry.data;
    if (event.event === "checkpoint") {
      applyCheckpoint(result, event, entry.id);
      continue;
    }
    const previous = result.watchers.get(event.logicalId);
    if (!validTransition(previous, event)) { result.ignored++; continue; }
    const snapshot = snapshotFromEvent(event)!;
    result.watchers.set(snapshot.logicalId, snapshot);
  }
  for (const { record, entry } of legacy.values()) {
    const snapshot = legacySnapshot(record, entry);
    if (!snapshot || result.watchers.has(snapshot.logicalId)) continue;
    result.watchers.set(snapshot.logicalId, snapshot);
    result.migratedLegacy++;
  }
  for (const [id, snapshot] of result.watchers) {
    if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now && !TERMINAL_STATES.has(snapshot.state)) {
      result.watchers.set(id, { ...snapshot, state: "expired", reason: "absolute expiry elapsed" });
    }
    if (!snapshot.config && NONTERMINAL_STATES.has(snapshot.state)) {
      const quarantined = { ...snapshot, state: "quarantined" as const, reason: "missing configuration" };
      result.watchers.set(id, quarantined);
      result.quarantined.push(quarantined);
    }
  }
  return result;
}

export function nextEvent(
  previous: WatcherSnapshot | undefined,
  fields: Omit<WatcherStateEvent, "schemaVersion" | "revision" | "createdAt"> & { createdAt?: string },
): WatcherStateEvent {
  return {
    ...fields,
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? fields.createdAt ?? fields.updatedAt,
  };
}

export function createCheckpoint(
  watchers: Iterable<WatcherSnapshot>, highWaterEntryId?: string, now = Date.now(),
): CheckpointData {
  const all = [...watchers];
  const active = all.filter((watcher) => NONTERMINAL_STATES.has(watcher.state));
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const recentTerminal = all.filter((watcher) => TERMINAL_STATES.has(watcher.state) && Date.parse(watcher.updatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 100);
  return { highWaterEntryId, active, recentTerminal };
}
