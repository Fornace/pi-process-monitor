import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEmptyDirectoryGc, planExternalGc } from "./gc.ts";
import type { MonitorRuntime } from "./runtime.ts";
import type { RuntimeWatcher, WatcherConfig, WatcherMode } from "./types.ts";

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

const probeSchema = Type.Union([
  Type.Object({ type: Type.Literal("process"), pidFile: Type.Optional(Type.String()), match: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("file"), path: Type.String(), tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
  Type.Object({ type: Type.Literal("ssh"), host: Type.String(), command: Type.String() }),
  Type.Object({ type: Type.Literal("http"), url: Type.String(), method: Type.Optional(StringEnum(["GET", "HEAD"] as const)) }),
]);

export const monitorParams = Type.Object({
  command: Type.Optional(Type.String({ description: "SOURCE (choose exactly one). Shell command to spawn once. Omit intervalSeconds, logFile, and probe." })),
  intervalSeconds: Type.Optional(Type.Number({ minimum: 2, description: "Poll cadence; enables poll mode." })),
  logFile: Type.Optional(Type.String({ description: "SOURCE (choose exactly one). File to tail. Omit command and probe." })),
  probe: Type.Optional(probeSchema),
  notifyOn: Type.Optional(Type.Array(Type.String())),
  heartbeatMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  label: Type.Optional(Type.String()),
  coalesceSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  cwd: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.1, description: "Compatibility lifetime converted once to absolute expiresAt." })),
  expiresAt: Type.Optional(Type.String({ description: "Absolute ISO-8601 watcher expiry." })),
  recoveryPolicy: Type.Optional(StringEnum(["never", "confirm", "safe-auto"] as const)),
  reuse: Type.Optional(StringEnum(["return-existing", "replace", "parallel"] as const)),
  reuseKey: Type.Optional(Type.String()),
  pollTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0.25 })),
  maxConsecutiveFailures: Type.Optional(Type.Integer({ minimum: 1 })),
  backoffMaxSeconds: Type.Optional(Type.Number({ minimum: 2 })),
  safetyClass: Type.Optional(StringEnum(["auto", "observer", "unsafe-shell"] as const)),
}, {
  // Keep the empty list explicit. Some OpenAI-compatible schema normalizers
  // treat an omitted root `required` keyword as if every property were required.
  required: [],
  additionalProperties: false,
});
type MonitorParams = Static<typeof monitorParams>;

const sourceKeys = ["command", "logFile", "probe"] as const;
const optionalKeys = Object.keys(monitorParams.properties).filter((key) => !sourceKeys.includes(key as typeof sourceKeys[number]));

function prepareMonitorArguments(args: unknown): MonitorParams {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args as MonitorParams;
  const input = { ...(args as Record<string, unknown>) };
  for (const key of optionalKeys) {
    if (input[key] === "" || input[key] === null) delete input[key];
  }
  // Compatibility repair for clients that materialize optional schema fields.
  // Preserve real conflicts so the exactly-one-source runtime guard still fails.
  const populatedSources = sourceKeys.filter((key) => hasPopulatedSource(input[key]));
  if (populatedSources.length === 1) {
    for (const key of sourceKeys) {
      if (key !== populatedSources[0] && isEmptySource(input[key])) delete input[key];
    }
  }
  return input as MonitorParams;
}

function hasPopulatedSource(value: unknown): boolean {
  return value !== undefined && !isEmptySource(value);
}

function isEmptySource(value: unknown): boolean {
  if (value === "" || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.entries(value).filter(([key]) => key !== "type" && !["tailLines", "method"].includes(key));
  return fields.length === 0 || fields.every(([, field]) => field === "" || field === null || field === undefined);
}

function sourceCount(params: MonitorParams): number {
  return sourceKeys.filter((key) => Boolean(params[key])).length;
}

function expiresAt(params: MonitorParams): string | undefined {
  if (params.expiresAt) {
    if (!Number.isFinite(Date.parse(params.expiresAt))) throw new Error("expiresAt must be a valid ISO timestamp");
    return new Date(params.expiresAt).toISOString();
  }
  return params.timeoutSeconds ? new Date(Date.now() + params.timeoutSeconds * 1000).toISOString() : undefined;
}

export function registerTools(pi: ExtensionAPI, runtime: MonitorRuntime): void {
  pi.registerTool({
    name: "monitor", label: "Monitor",
    description: "Start or exactly reuse a non-blocking watcher. Provide exactly one SOURCE field: command, logFile, or probe. Omit unused source fields completely. Local shell polls are quarantined unless explicitly acknowledged as observers.",
    promptSnippet: "Watch an owned process or independent durable job without blocking",
    promptGuidelines: [
      "Use monitor with exactly one source: command, logFile, or probe. Omit the other two fields instead of sending empty values.",
      "Use monitor spawn for a local workload; use monitor poll only for a fast read-only probe of an independently owned job.",
      "Call monitor_status before creating a watcher or use monitor reuse=return-existing; never duplicate a workload with blocking bash retries.",
      "Use narrow PID, run, workflow, exact path, or remote job identity; set expiresAt for temporary watchers.",
    ],
    parameters: monitorParams,
    prepareArguments: prepareMonitorArguments,
    async execute(_id, params: MonitorParams, _signal, _update, ctx) {
      if (sourceCount(params) !== 1) throw new Error("provide exactly one source: command, logFile, or probe");
      const config = {
        ...params, cwd: params.cwd ?? ctx.cwd, expiresAt: expiresAt(params),
      } as Omit<WatcherConfig, "recoveryPolicy" | "reuse"> & Partial<Pick<WatcherConfig, "recoveryPolicy" | "reuse">>;
      const result = await runtime.launch(config);
      return { ...text(`${result.action.toUpperCase()}: watcher ${result.watcher.handleId} [${result.watcher.mode}] state=${result.watcher.state}${result.reason ? ` reason=${result.reason}` : ""}`), details: { action: result.action, watcher: watcherMeta(result.watcher) } };
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
