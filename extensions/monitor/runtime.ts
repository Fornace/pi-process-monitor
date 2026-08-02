import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireLease, leasePath, leaseRoot, makeOwner, releaseLease, renewLease } from "./leases.ts";
import { classifyPoll, defaultRecoveryPolicy, modeFor, newLogicalId, shortHandle, sourceFingerprint } from "./identity.ts";
import { evaluateFuse, recordCleanShutdown, recordRuntimeStart, type FuseDecision } from "./recovery.ts";
import { createCheckpoint, nextEvent, reduceState } from "./state.ts";
import { startFileRuntime } from "./file.ts";
import { startPollRuntime } from "./poll.ts";
import { startSpawnRuntime } from "./spawn.ts";
import { compileMatchers, createCoalescer, probeCommand } from "./util.ts";
import {
  STATE_CUSTOM_TYPE, type LifecycleState, type ReducedState, type RuntimeWatcher,
  type SessionEntryLike, type WatcherConfig, type WatcherSnapshot, type WatcherStateEvent,
} from "./types.ts";

export interface LaunchResult {
  action: "created" | "reused" | "replaced" | "quarantined";
  watcher: RuntimeWatcher;
  reason?: string;
}

export class MonitorRuntime {
  readonly watchers = new Map<string, RuntimeWatcher>();
  readonly runtimeId = randomUUID();
  private sessionId = "ephemeral";
  private stateRoot = leaseRoot();
  private shuttingDown = false;
  private fuse: FuseDecision = { quarantineLocalPolls: false, disableAllLocalRecovery: false, recent10m: 0, recent30m: 0 };
  private snapshots = new Map<string, WatcherSnapshot>();
  private stateEvents = 0;

  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) { this.pi = pi; }

  private append(event: WatcherStateEvent): void {
    this.pi.appendEntry(STATE_CUSTOM_TYPE, event);
    this.stateEvents++;
    if (event.event !== "checkpoint") {
      this.snapshots.set(event.logicalId, {
        logicalId: event.logicalId, revision: event.revision, state: event.event,
        mode: event.mode, sourceFingerprint: event.sourceFingerprint,
        createdAt: event.createdAt, updatedAt: event.updatedAt, expiresAt: event.expiresAt,
        recoveryPolicy: event.recoveryPolicy, config: event.config, owner: event.owner, reason: event.reason,
      });
    }
  }

  private transition(watcher: RuntimeWatcher, state: LifecycleState, reason?: string): void {
    const previous = this.snapshots.get(watcher.logicalId);
    const event = nextEvent(previous, {
      logicalId: watcher.logicalId, event: state, mode: watcher.mode,
      sourceFingerprint: watcher.sourceFingerprint, owner: watcher.owner,
      updatedAt: new Date().toISOString(), expiresAt: watcher.config.expiresAt,
      recoveryPolicy: watcher.config.recoveryPolicy, config: watcher.config, reason,
    });
    watcher.revision = event.revision;
    watcher.state = state;
    this.append(event);
  }

  private emit(watcher: RuntimeWatcher, body: string): void {
    watcher.lastEventAt = Date.now();
    watcher.eventCount++;
    this.pi.sendMessage(
      { customType: "monitor", content: `[watcher ${watcher.handleId}${watcher.label ? ` · ${watcher.label}` : ""}] ${body}`, display: true, details: { logicalId: watcher.logicalId } },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  private findExisting(config: WatcherConfig, fingerprint: string): RuntimeWatcher | undefined {
    return [...this.watchers.values()].find((watcher) => watcher.state !== "stopped" && (
      config.reuseKey ? watcher.config.reuseKey === config.reuseKey : watcher.sourceFingerprint === fingerprint
    ));
  }

  async launch(input: Omit<WatcherConfig, "recoveryPolicy" | "reuse"> & Partial<Pick<WatcherConfig, "recoveryPolicy" | "reuse">>, restoring?: WatcherSnapshot): Promise<LaunchResult> {
    const draft = { ...input } as WatcherConfig;
    draft.reuse ??= "return-existing";
    draft.cwd ||= process.cwd();
    const mode = restoring?.mode ?? modeFor(draft);
    draft.recoveryPolicy ??= defaultRecoveryPolicy(mode, draft);
    const fingerprint = restoring?.sourceFingerprint ?? sourceFingerprint(draft, mode);
    const existing = this.findExisting(draft, fingerprint);
    if (existing && draft.reuse === "return-existing") return { action: "reused", watcher: existing };
    if (existing && draft.reuse === "replace") await existing.stop("stop");
    if (draft.reuse === "parallel" && !draft.reuseKey && mode === "poll" && classifyPoll(draft).local) {
      return this.quarantined(draft, mode, fingerprint, "parallel local poll requires a distinct reuseKey");
    }
    const logicalId = restoring?.logicalId ?? newLogicalId();
    const watcher = this.makeWatcher(logicalId, mode, draft, fingerprint, restoring);
    if (!restoring) this.transition(watcher, "created");
    const safety = mode === "poll" ? classifyPoll(draft) : undefined;
    const policyBlock = draft.recoveryPolicy === "confirm" && restoring;
    const unsafeBlock = mode === "poll" && safety?.local && safety.classification !== "safe-observer" && draft.safetyClass !== "observer";
    const fuseBlock = Boolean(restoring && safety?.local && (this.fuse.disableAllLocalRecovery || this.fuse.quarantineLocalPolls));
    if (policyBlock || unsafeBlock || fuseBlock) {
      const reason = fuseBlock ? "abnormal-restart fuse" : unsafeBlock ? `unsafe local poll: ${safety?.reasons.join(", ")}` : "recovery requires confirmation";
      this.watchers.set(logicalId, watcher);
      this.transition(watcher, "quarantined", reason);
      this.installQuarantinedStop(watcher);
      return { action: "quarantined", watcher, reason };
    }
    let claim = false;
    try { claim = await this.claim(watcher); }
    catch (error) {
      const reason = `lease claim failed closed: ${(error as Error).message}`;
      this.watchers.set(logicalId, watcher);
      this.transition(watcher, "quarantined", reason);
      this.installQuarantinedStop(watcher);
      return { action: "quarantined", watcher, reason };
    }
    if (!claim) {
      const reason = "another live runtime owns this logical watcher";
      watcher.state = "released";
      return { action: "reused", watcher, reason };
    }
    this.watchers.set(logicalId, watcher);
    try { this.startResources(watcher); }
    catch (error) {
      await this.releaseClaim(watcher);
      this.watchers.delete(logicalId);
      const reason = `resource startup failed: ${(error as Error).message}`;
      this.transition(watcher, "quarantined", reason);
      this.watchers.set(logicalId, watcher);
      this.installQuarantinedStop(watcher);
      return { action: "quarantined", watcher, reason };
    }
    return { action: restoring ? "reused" : existing ? "replaced" : "created", watcher };
  }

  private quarantined(config: WatcherConfig, mode: RuntimeWatcher["mode"], fingerprint: string, reason: string): LaunchResult {
    const watcher = this.makeWatcher(newLogicalId(), mode, config, fingerprint);
    this.transition(watcher, "created");
    this.watchers.set(watcher.logicalId, watcher);
    this.transition(watcher, "quarantined", reason);
    this.installQuarantinedStop(watcher);
    return { action: "quarantined", watcher, reason };
  }

  private installQuarantinedStop(watcher: RuntimeWatcher): void {
    let stopped = false;
    watcher.stop = async (intent = "stop") => {
      if (stopped) return;
      stopped = true;
      this.transition(watcher, intent === "expire" ? "expired" : "stopped", intent === "stop" ? "quarantine rejected" : undefined);
      this.watchers.delete(watcher.logicalId);
    };
  }

  private makeWatcher(id: string, mode: RuntimeWatcher["mode"], config: WatcherConfig, fingerprint: string, previous?: WatcherSnapshot): RuntimeWatcher {
    return {
      logicalId: id, handleId: shortHandle(id), label: config.label ?? "", mode,
      state: previous?.state ?? "created", config, sourceFingerprint: fingerprint,
      revision: previous?.revision ?? 0, createdAt: Date.parse(previous?.createdAt ?? "") || Date.now(),
      lastEventAt: null, lastTickAt: null, eventCount: 0, consecutiveFailures: 0,
      stop: async () => {},
    };
  }

  private async releaseClaim(watcher: RuntimeWatcher): Promise<void> {
    await (watcher as RuntimeWatcher & { releaseLease?: () => Promise<void> }).releaseLease?.();
  }

  private async claim(watcher: RuntimeWatcher): Promise<boolean> {
    const path = leasePath(this.stateRoot, this.sessionId, watcher.logicalId);
    const owner = makeOwner(this.runtimeId);
    const claim = await acquireLease(path, owner);
    if (!claim.acquired) {
      watcher.owner = claim.existing;
      watcher.foreignOwner = true;
      return false;
    }
    watcher.owner = owner;
    this.transition(watcher, "claimed", claim.staleArchived ? "reclaimed stale lease" : undefined);
    const leaseHeartbeat = setInterval(() => {
      if (!watcher.owner) return;
      void renewLease(path, watcher.owner).then((renewed) => { watcher.owner = renewed; }).catch(async () => {
        await watcher.stop("quarantine");
      });
    }, 15_000);
    leaseHeartbeat.unref?.();
    const release = async () => {
      clearInterval(leaseHeartbeat);
      if (watcher.owner) await releaseLease(path, watcher.owner);
      watcher.owner = undefined;
    };
    (watcher as RuntimeWatcher & { releaseLease?: () => Promise<void> }).releaseLease = release;
    return true;
  }

  private startResources(watcher: RuntimeWatcher): void {
    const matcher = compileMatchers(watcher.config.notifyOn);
    const coalescer = createCoalescer((body) => this.emit(watcher, body), watcher.config.coalesceSeconds, watcher.config.maxLines);
    const command = probeCommand(watcher.config);
    let resourceStop: () => Promise<void> | void;
    if (watcher.mode === "spawn") {
      if (!command) throw new Error("spawn watcher requires command");
      const controller = startSpawnRuntime({ watcher, command, push: coalescer.push, onFailure: (message) => this.emit(watcher, message), onExit: (code, signal) => {
        this.emit(watcher, `PROCESS EXITED (code=${code} signal=${signal ?? "none"})`);
        void watcher.stop("stop");
      } });
      resourceStop = controller.stop;
    } else if (watcher.mode === "poll") {
      if (!command) throw new Error("poll watcher requires command or probe");
      const controller = startPollRuntime({ watcher, command, matcher, push: coalescer.push,
        onFailure: (message) => this.emit(watcher, message), ownedChildren: () => [...this.watchers.values()].filter((item) => item.child).length,
        onCriticalPressure: (sample) => { this.emit(watcher, `HOST PRESSURE CRITICAL: ${sample.reasons.join(", ")}`); void watcher.stop("quarantine"); },
      });
      resourceStop = controller.stop;
    } else {
      const controller = startFileRuntime({ watcher, matcher, push: coalescer.push, onFailure: (message) => this.emit(watcher, message) });
      resourceStop = controller.stop;
    }
    let expiry: NodeJS.Timeout | undefined;
    if (watcher.config.expiresAt) {
      expiry = setTimeout(() => void watcher.stop("expire"), Math.max(0, Date.parse(watcher.config.expiresAt) - Date.now()));
      expiry.unref?.();
    }
    let heartbeat: NodeJS.Timeout | undefined;
    if (watcher.config.heartbeatMinutes) {
      heartbeat = setInterval(() => this.emit(watcher, `heartbeat: still running (events=${watcher.eventCount})`), Math.max(1, watcher.config.heartbeatMinutes) * 60_000);
      heartbeat.unref?.();
    }
    let stopped = false;
    watcher.stop = async (intent = "stop") => {
      if (stopped) return;
      stopped = true;
      if (expiry) clearTimeout(expiry);
      if (heartbeat) clearInterval(heartbeat);
      coalescer.cancel();
      await resourceStop();
      await this.releaseClaim(watcher);
      const state = intent === "release" ? "released" : intent === "expire" ? "expired" : intent === "quarantine" ? "quarantined" : "stopped";
      if (!(this.shuttingDown && state === "released")) this.transition(watcher, state);
      else this.transition(watcher, "released", "clean session shutdown");
      if (state !== "quarantined") this.watchers.delete(watcher.logicalId);
    };
  }

  async startSession(ctx: ExtensionContext): Promise<ReducedState> {
    this.shuttingDown = false;
    this.sessionId = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
    const history = recordRuntimeStart(this.stateRoot, this.sessionId);
    this.fuse = evaluateFuse(history);
    const reduced = reduceState(ctx.sessionManager.getBranch() as SessionEntryLike[]);
    this.snapshots = reduced.watchers;
    const summary = { resumed: 0, reused: 0, expired: 0, quarantined: 0, compacted: reduced.ignored };
    for (const snapshot of reduced.watchers.values()) {
      if (["stopped", "expired"].includes(snapshot.state)) { if (snapshot.state === "expired") summary.expired++; continue; }
      if (snapshot.recoveryPolicy === "never" || !snapshot.config) continue;
      const result = await this.launch(snapshot.config, snapshot);
      if (result.action === "quarantined") summary.quarantined++;
      else if (result.reason?.includes("another live")) summary.reused++;
      else summary.resumed++;
    }
    if (summary.resumed + summary.reused + summary.expired + summary.quarantined + summary.compacted > 0) {
      ctx.ui?.notify?.(`monitor recovery: ${summary.resumed} resumed, ${summary.reused} reused, ${summary.expired} expired, ${summary.quarantined} quarantined, ${summary.compacted} stale records compacted`, "info");
    }
    return reduced;
  }

  async checkpoint(highWaterEntryId?: string): Promise<void> {
    const now = new Date().toISOString();
    const checkpoint = createCheckpoint(this.snapshots.values(), highWaterEntryId);
    this.append({
      schemaVersion: 2, logicalId: "__checkpoint__", revision: 1, event: "checkpoint",
      mode: "file", sourceFingerprint: "checkpoint", createdAt: now, updatedAt: now,
      recoveryPolicy: "never", checkpoint,
    });
    this.stateEvents = 0;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.stop("release")));
    this.watchers.clear();
    await this.checkpoint();
    recordCleanShutdown(this.stateRoot, this.sessionId);
  }

  getSessionId(): string { return this.sessionId; }
  getStateRoot(): string { return this.stateRoot; }
  getSnapshots(): WatcherSnapshot[] { return [...this.snapshots.values()]; }

  find(id: string): RuntimeWatcher | undefined {
    return this.watchers.get(id) ?? [...this.watchers.values()].find((watcher) => watcher.handleId === id || watcher.logicalId.startsWith(id));
  }

  async recover(id: string, approve: boolean): Promise<LaunchResult | undefined> {
    const watcher = this.find(id);
    if (!watcher || watcher.state !== "quarantined" || watcher.foreignOwner) return undefined;
    if (!approve) { await watcher.stop("stop"); return undefined; }
    this.watchers.delete(watcher.logicalId);
    return this.launch({ ...watcher.config, recoveryPolicy: "safe-auto", safetyClass: "observer" }, this.snapshots.get(watcher.logicalId));
  }
}
