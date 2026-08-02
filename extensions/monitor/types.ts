import type { ChildProcess } from "node:child_process";

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export const systemClock: Clock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

export const STATE_SCHEMA_VERSION = 2 as const;
export const STATE_CUSTOM_TYPE = "monitor-state-v2";
export const LEGACY_CUSTOM_TYPE = "monitor-watcher";

export type WatcherMode = "spawn" | "poll" | "file";
export type RecoveryPolicy = "never" | "confirm" | "safe-auto";
export type ReuseMode = "return-existing" | "replace" | "parallel";
export type SafetyClass = "auto" | "observer" | "unsafe-shell";
export type LifecycleState =
  | "created" | "claimed" | "heartbeat" | "released" | "stopped"
  | "expired" | "quarantined";

export type Probe =
  | { type: "process"; pidFile?: string; match?: string }
  | { type: "file"; path: string; tailLines?: number }
  | { type: "ssh"; host: string; command: string }
  | { type: "http"; url: string; method?: "GET" | "HEAD" };

export interface WatcherConfig {
  command?: string;
  logFile?: string;
  probe?: Probe;
  intervalSeconds?: number;
  cwd: string;
  notifyOn?: string[];
  heartbeatMinutes?: number;
  coalesceSeconds?: number;
  maxLines?: number;
  expiresAt?: string;
  pollTimeoutSeconds?: number;
  maxConsecutiveFailures?: number;
  backoffMaxSeconds?: number;
  safetyClass?: SafetyClass;
  recoveryPolicy: RecoveryPolicy;
  reuse: ReuseMode;
  reuseKey?: string;
  label?: string;
}

export interface OwnerRecord {
  runtimeId: string;
  ownerEpoch: string;
  pid: number;
  bootId: string;
  processStart: string;
  leaseUntil: string;
}

export interface WatcherStateEvent {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  logicalId: string;
  revision: number;
  event: LifecycleState | "checkpoint";
  mode: WatcherMode;
  sourceFingerprint: string;
  owner?: OwnerRecord;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  recoveryPolicy: RecoveryPolicy;
  config?: WatcherConfig;
  reason?: string;
  checkpoint?: CheckpointData;
}

export interface WatcherSnapshot {
  logicalId: string;
  revision: number;
  state: LifecycleState;
  mode: WatcherMode;
  sourceFingerprint: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  recoveryPolicy: RecoveryPolicy;
  config?: WatcherConfig;
  owner?: OwnerRecord;
  reason?: string;
  legacy?: boolean;
}

export interface CheckpointData {
  highWaterEntryId?: string;
  active: WatcherSnapshot[];
  recentTerminal: WatcherSnapshot[];
}

export interface ReducedState {
  watchers: Map<string, WatcherSnapshot>;
  quarantined: WatcherSnapshot[];
  malformed: number;
  ignored: number;
  migratedLegacy: number;
  checkpointEntryId?: string;
}

export interface SessionEntryLike {
  type: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  data?: unknown;
}

export interface ProcessReceipt {
  logicalId: string;
  ownerEpoch: string;
  commandHash: string;
  displayCommand: string;
  cwd: string;
  pid?: number;
  pgid?: number;
  parentPid: number;
  bootId: string;
  processStart?: string;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  termSentAt?: string;
  killSentAt?: string;
  peakRssBytes?: number;
  stdoutTruncatedBytes: number;
  stderrTruncatedBytes: number;
  cleanupVerified?: boolean;
}

export interface RuntimeWatcher {
  logicalId: string;
  handleId: string;
  label: string;
  mode: WatcherMode;
  state: LifecycleState;
  config: WatcherConfig;
  sourceFingerprint: string;
  revision: number;
  createdAt: number;
  lastEventAt: number | null;
  lastTickAt: number | null;
  eventCount: number;
  consecutiveFailures: number;
  nextTickAt?: number;
  owner?: OwnerRecord;
  receipt?: ProcessReceipt;
  receipts: ProcessReceipt[];
  child?: ChildProcess;
  foreignOwner?: boolean;
  stop: (intent?: "stop" | "release" | "expire" | "quarantine") => Promise<void>;
}

export const TERMINAL_STATES = new Set<LifecycleState>(["stopped", "expired"]);
export const NONTERMINAL_STATES = new Set<LifecycleState>([
  "created", "claimed", "heartbeat", "released", "quarantined",
]);
