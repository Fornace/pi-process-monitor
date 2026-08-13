import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEmptyDirectoryGc, planExternalGc } from "./gc.ts";
import { monitorParams, prepareMonitorArguments, resolveMonitorInput, type MonitorParams } from "./input.ts";
import type { MonitorRuntime } from "./runtime.ts";
import type { RuntimeWatcher } from "./types.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function watcherMeta(watcher: RuntimeWatcher) {
  return {
    id: watcher.handleId,
    logicalId: watcher.logicalId,
    label: watcher.label,
    mode: watcher.mode,
    state: watcher.state,
    sourceFingerprint: watcher.sourceFingerprint,
    recoveryPolicy: watcher.config.recoveryPolicy,
    safetyClass: watcher.config.safetyClass,
    owner: watcher.owner,
    expiresAt: watcher.config.expiresAt,
    startedAt: new Date(watcher.createdAt).toISOString(),
    lastEventAt: watcher.lastEventAt ? new Date(watcher.lastEventAt).toISOString() : null,
    lastTickAt: watcher.lastTickAt ? new Date(watcher.lastTickAt).toISOString() : null,
    nextTickAt: watcher.nextTickAt ? new Date(watcher.nextTickAt).toISOString() : null,
    eventCount: watcher.eventCount,
    consecutiveFailures: watcher.consecutiveFailures,
    receipt: watcher.receipt,
    receipts: watcher.receipts,
    foreignOwner: watcher.foreignOwner,
  };
}

export function registerTools(pi: ExtensionAPI, runtime: MonitorRuntime): void {
  pi.registerTool({
    name: "monitor", label: "Monitor",
    description: "Start or exactly reuse one non-blocking watcher. Select an explicit source.type: spawn, poll, tail, process, file, ssh, or http. source.type is authoritative; unrelated generated fields are ignored. Local shell polls are quarantined unless explicitly acknowledged as observers.",
    promptSnippet: "Watch an owned process or independent durable job without blocking",
    promptGuidelines: [
      "Use monitor with one explicit source object. Set source.type to spawn, poll, tail, process, file, ssh, or http; source.type is authoritative.",
      "Use source.type=spawn for a local workload. Use source.type=poll only for a fast read-only shell observation; use process/file/ssh/http for structured observers.",
      "Call monitor_status before creating a watcher or use options.reuse=return-existing; never duplicate a workload with blocking bash retries.",
      "Use narrow PID, run, workflow, exact path, or remote job identity; set options.expiresAt for temporary watchers.",
    ],
    parameters: monitorParams,
    prepareArguments: prepareMonitorArguments,
    async execute(_id, params: MonitorParams, _signal, _update, ctx) {
      const { config, sourceType, ignoredSourceFields } = resolveMonitorInput(params, ctx.cwd);
      const result = await runtime.launch(config);
      const ignored = ignoredSourceFields.length
        ? ` Ignored unrelated source fields for source.type=${sourceType}: ${ignoredSourceFields.join(", ")}.`
        : "";
      const next = result.action === "quarantined"
        ? " Next: call monitor_inspect; do not approve or repeat the watcher automatically."
        : " Next: continue working; use monitor_status to inspect it. Do not call monitor again just to check status.";
      return {
        ...text(`${result.action.toUpperCase()}: watcher ${result.watcher.handleId} [${result.watcher.mode}] state=${result.watcher.state}${result.reason ? ` reason=${result.reason}` : "."}${ignored}${next}`),
        details: { action: result.action, watcher: watcherMeta(result.watcher), sourceType, ignoredSourceFields },
      };
    },
  });

  pi.registerTool({
    name: "monitor_status", label: "Monitor status", description: "List logical watchers, lifecycle, owner, recovery, expiry, tick, and failure status.",
    parameters: Type.Object({}), async execute() {
      const watchers = [...runtime.watchers.values()].map(watcherMeta);
      if (!watchers.length) return { ...text("No watchers."), details: { watchers } };
      const lines = watchers.map((item) => `${item.id} · ${item.logicalId.slice(0, 8)} [${item.mode}] state=${item.state} owner=${item.owner?.runtimeId ?? "none"} recovery=${item.recoveryPolicy} expires=${item.expiresAt ?? "never"} lastTick=${item.lastTickAt ?? "never"} failures=${item.consecutiveFailures}`);
      return { ...text(lines.join("\n")), details: { watchers } };
    },
  });

  pi.registerTool({
    name: "monitor_inspect", label: "Monitor inspect", description: "Inspect logical identity, lease owner, recovery configuration, and owned process receipt.",
    parameters: Type.Object({ id: Type.String() }), async execute(_id, params) {
      const watcher = runtime.find(params.id);
      const value = watcher ? watcherMeta(watcher) : null;
      return { ...text(value ? JSON.stringify(value, null, 2) : `No watcher ${params.id}.`), details: { watcher: value } };
    },
  });

  pi.registerTool({
    name: "monitor_kill", label: "Monitor kill", description: "Stop one logical watcher and only its verified extension-owned process group.",
    parameters: Type.Object({ id: Type.String() }), async execute(_id, params) {
      const watcher = runtime.find(params.id);
      if (watcher && !watcher.foreignOwner) await watcher.stop("stop");
      const value = watcher ? watcherMeta(watcher) : null;
      return { ...text(watcher ? `${watcher.foreignOwner ? "Skipped foreign owner" : "Stopped"} ${watcher.handleId}; cleanup=${watcher.receipt?.cleanupVerified ?? "n/a"}.` : `No watcher ${params.id}.`), details: { watcher: value } };
    },
  });

  pi.registerTool({
    name: "monitor_recover", label: "Monitor recover", description: "List, approve, or reject quarantined watchers. Approval is explicit and reversible.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), action: Type.Optional(StringEnum(["list", "approve", "reject"] as const)) }),
    async execute(_id, params) {
      const quarantined = [...runtime.watchers.values()].filter((watcher) => watcher.state === "quarantined");
      if (!params.id || !params.action || params.action === "list") return { ...text(quarantined.length ? quarantined.map((watcher) => `${watcher.handleId} ${watcher.label} reason=${runtime.getSnapshots().find((item) => item.logicalId === watcher.logicalId)?.reason ?? "unknown"}`).join("\n") : "No quarantined watchers."), details: { watchers: quarantined.map(watcherMeta) } };
      const result = await runtime.recover(params.id, params.action === "approve");
      const current = [...runtime.watchers.values()].filter((watcher) => watcher.state === "quarantined").map(watcherMeta);
      return { ...text(result ? `${result.action}: ${result.watcher.handleId}` : `${params.action} completed for ${params.id}`), details: { watchers: current } };
    },
  });

  pi.registerTool({
    name: "monitor_gc", label: "Monitor GC", description: "Checkpoint logical state and clean stale external leases. Dry-run by default.",
    parameters: Type.Object({ apply: Type.Optional(Type.Boolean({ default: false })) }), async execute(_id, params) {
      const plan = await planExternalGc(runtime.getStateRoot(), Boolean(params.apply));
      let removedDirectories = 0;
      if (params.apply) { await runtime.checkpoint(); removedDirectories = await applyEmptyDirectoryGc(plan); }
      return { ...text(`monitor gc ${params.apply ? "applied" : "dry-run"}: scanned=${plan.scanned} live=${plan.live.length} stale=${plan.stale.length} corrupt=${plan.corrupt.length} emptyDirs=${plan.emptyDirectories.length} removedDirs=${removedDirectories}`), details: { plan, applied: Boolean(params.apply), removedDirectories } };
    },
  });

  pi.registerTool({
    name: "monitor_kill_all", label: "Monitor kill all", description: "Stop all current-session extension-owned watchers. Requires confirm=true.",
    parameters: Type.Object({ confirm: Type.Boolean() }), async execute(_id, params) {
      if (!params.confirm) throw new Error("monitor_kill_all requires confirm=true");
      const list = [...runtime.watchers.values()].filter((watcher) => !watcher.foreignOwner);
      await Promise.all(list.map((watcher) => watcher.stop("stop")));
      return { ...text(`Stopped ${list.length} current-session watcher(s).`), details: { stopped: list.map(watcherMeta) } };
    },
  });
}
