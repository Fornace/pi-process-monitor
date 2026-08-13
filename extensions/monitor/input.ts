import { Type, type Static, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Probe, WatcherConfig } from "./types.ts";

const sourceTypes = ["spawn", "poll", "tail", "process", "file", "ssh", "http"] as const;
const optionKeys = [
  "notifyOn", "heartbeatMinutes", "label", "coalesceSeconds", "maxLines", "cwd",
  "timeoutSeconds", "expiresAt", "recoveryPolicy", "reuse", "reuseKey",
  "pollTimeoutSeconds", "maxConsecutiveFailures", "backoffMaxSeconds", "safetyClass",
] as const;
const legacySourceKeys = ["command", "logFile", "probe", "intervalSeconds"] as const;
const sourceValueKeys = [
  "command", "path", "processBy", "pidFile", "match", "host", "url", "method", "tailLines", "intervalSeconds",
] as const;

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const nullableString = (description: string) => nullable(Type.String({ description }));

export const monitorSourceSchema = Type.Object({
  type: StringEnum(sourceTypes, {
    description: "Watcher source: spawn runs a command once; poll repeats a read-only command; tail follows a log; process/file/ssh/http are structured observers.",
  }),
  command: nullableString("Command for spawn/poll/ssh. Use null for other source types."),
  path: nullableString("Path for tail/file. Use null for other source types."),
  processBy: nullable(StringEnum(["pidFile", "match"] as const, { description: "For process, selects the authoritative identity field; otherwise null." })),
  pidFile: nullableString("PID file for process when processBy=pidFile. Use null otherwise."),
  match: nullableString("Narrow process match when processBy=match. Use null otherwise."),
  host: nullableString("SSH host for ssh. Use null for other source types."),
  url: nullableString("HTTP/HTTPS URL for http. Use null for other source types."),
  method: nullable(StringEnum(["GET", "HEAD"] as const, { description: "HTTP method for http; otherwise null." })),
  tailLines: nullable(Type.Integer({ minimum: 1, maximum: 1000, description: "Initial/tick tail size for file; otherwise null." })),
  intervalSeconds: nullable(Type.Number({ minimum: 2, description: "Cadence for poll/process/ssh/http; null uses 30 seconds. Ignored for spawn/tail/file." })),
}, {
  additionalProperties: false,
  description: "One explicit source. source.type is authoritative; unrelated generated fields are ignored.",
});

export const monitorOptionsSchema = Type.Object({
  notifyOn: nullable(Type.Array(Type.String())),
  heartbeatMinutes: nullable(Type.Number({ minimum: 1 })),
  label: nullable(Type.String()),
  coalesceSeconds: nullable(Type.Number({ minimum: 0 })),
  maxLines: nullable(Type.Integer({ minimum: 1, maximum: 2000 })),
  cwd: nullable(Type.String()),
  timeoutSeconds: nullable(Type.Number({ minimum: 0.1, description: "Compatibility lifetime converted once to expiresAt." })),
  expiresAt: nullable(Type.String({ description: "Absolute ISO-8601 watcher expiry." })),
  recoveryPolicy: nullable(StringEnum(["never", "confirm", "safe-auto"] as const)),
  reuse: nullable(StringEnum(["return-existing", "replace", "parallel"] as const)),
  reuseKey: nullable(Type.String()),
  pollTimeoutSeconds: nullable(Type.Number({ minimum: 0.25 })),
  maxConsecutiveFailures: nullable(Type.Integer({ minimum: 1 })),
  backoffMaxSeconds: nullable(Type.Number({ minimum: 2 })),
  safetyClass: nullable(StringEnum(["auto", "observer", "unsafe-shell"] as const)),
}, { additionalProperties: false });

export const monitorParams = Type.Object({
  source: monitorSourceSchema,
  options: Type.Union([monitorOptionsSchema, Type.Null()], {
    description: "Optional lifecycle and notification settings. Use null when none are needed; inside an object, use null for every unset field.",
  }),
}, {
  additionalProperties: false,
  description: "Start or reuse one watcher. The required source discriminator prevents mutually exclusive source fields from conflicting under strict tool schemas.",
});

export type MonitorParams = Static<typeof monitorParams>;
type MonitorSource = Static<typeof monitorSourceSchema>;
type MonitorOptions = Static<typeof monitorOptionsSchema>;
type SourceType = MonitorSource["type"];
type LaunchInput = Omit<WatcherConfig, "recoveryPolicy" | "reuse"> & Partial<Pick<WatcherConfig, "recoveryPolicy" | "reuse">>;

export interface ResolvedMonitorInput {
  config: LaunchInput;
  sourceType: SourceType;
  ignoredSourceFields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanNullable(value: unknown): unknown {
  return value === "" || value === undefined ? null : value;
}

function describeLegacySource(key: string, value: unknown): string {
  if (key === "probe" && isRecord(value)) return `probe(type=${JSON.stringify(value.type ?? "unknown")})`;
  return key;
}

function isPopulatedLegacySource(key: string, value: unknown): boolean {
  if (key === "command" || key === "logFile") return typeof value === "string" && value.trim().length > 0;
  if (key !== "probe" || !isRecord(value)) return false;
  return Object.entries(value).some(([field, item]) => field !== "type" && item !== "" && item !== null && item !== undefined);
}

function sourceExample(type: SourceType): string {
  const examples: Record<SourceType, object> = {
    spawn: { source: { type: "spawn", command: "npm test" }, options: null },
    poll: { source: { type: "poll", command: "gh run view 123", intervalSeconds: 15 }, options: null },
    tail: { source: { type: "tail", path: "/tmp/job.log" }, options: null },
    process: { source: { type: "process", processBy: "pidFile", pidFile: "/tmp/job.pid" }, options: null },
    file: { source: { type: "file", path: "/tmp/job.log" }, options: null },
    ssh: { source: { type: "ssh", host: "worker", command: "tail -n5 /tmp/job.log" }, options: null },
    http: { source: { type: "http", url: "https://ci.example/runs/123", method: "GET" }, options: null },
  };
  return JSON.stringify(examples[type]);
}

function normalizeLegacyProbe(probe: Record<string, unknown>, intervalSeconds: unknown): Record<string, unknown> {
  const type = probe.type;
  if (!sourceTypes.includes(type as SourceType) || !["process", "file", "ssh", "http"].includes(String(type))) {
    throw new Error(`monitor legacy probe.type must be process, file, ssh, or http; received ${JSON.stringify(type)}.`);
  }
  return {
    type,
    command: probe.command,
    path: probe.path,
    processBy: probe.type === "process"
      ? (typeof probe.pidFile === "string" && probe.pidFile.trim() ? "pidFile" : "match")
      : undefined,
    pidFile: probe.pidFile,
    match: probe.match,
    host: probe.host,
    url: probe.url,
    method: probe.method,
    tailLines: probe.tailLines,
    intervalSeconds,
  };
}

function legacySource(input: Record<string, unknown>): Record<string, unknown> {
  const populated = ["command", "logFile", "probe"].filter((key) => isPopulatedLegacySource(key, input[key]));
  if (populated.length === 0) {
    throw new Error(`monitor needs one explicit source. Examples: ${sourceExample("spawn")} or ${sourceExample("tail")}`);
  }
  if (populated.length > 1) {
    const names = populated.map((key) => describeLegacySource(key, input[key])).join(", ");
    const likelyStrictMaterialization = populated.includes("command") && input.logFile === "" && isRecord(input.probe);
    const hint = likelyStrictMaterialization
      ? "This is the known 2.0.1 strict-schema payload: the provider materialized every legacy source field. "
      : "This call contains multiple real legacy sources. ";
    throw new Error(
      `monitor received conflicting legacy sources: ${names}. ${hint}`
      + `Use source.type to select one source explicitly, for example ${sourceExample(typeof input.command === "string" && input.command.trim() ? (input.intervalSeconds ? "poll" : "spawn") : "tail")}`,
    );
  }
  if (populated[0] === "command") {
    return { type: input.intervalSeconds ? "poll" : "spawn", command: input.command, intervalSeconds: input.intervalSeconds };
  }
  if (populated[0] === "logFile") return { type: "tail", path: input.logFile };
  return normalizeLegacyProbe(input.probe as Record<string, unknown>, input.intervalSeconds);
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], location: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`monitor received unsupported ${location} field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function normalizeSource(raw: unknown): MonitorSource {
  if (!isRecord(raw)) throw new Error("monitor source must be an object with an explicit source.type discriminator.");
  rejectUnknown(raw, ["type", ...sourceValueKeys], "source");
  if (!sourceTypes.includes(raw.type as SourceType)) {
    throw new Error(`monitor source.type must be one of ${sourceTypes.join(", ")}; received ${JSON.stringify(raw.type)}.`);
  }
  const source = { type: raw.type } as Record<string, unknown>;
  for (const key of sourceValueKeys) source[key] = cleanNullable(raw[key]);
  if (typeof source.method === "string") source.method = source.method.toUpperCase();
  return source as MonitorSource;
}

function normalizeOptions(raw: unknown, legacy: Record<string, unknown>): MonitorOptions | null {
  if (raw !== undefined && raw !== null && !isRecord(raw)) throw new Error("monitor options must be an object or null.");
  const explicit = isRecord(raw) ? raw : {};
  rejectUnknown(explicit, optionKeys, "options");
  const values = Object.fromEntries(optionKeys.map((key) => [
    key,
    cleanNullable(Object.hasOwn(explicit, key) ? explicit[key] : legacy[key]),
  ]));
  return Object.values(values).every((value) => value === null) ? null : values as unknown as MonitorOptions;
}

export function prepareMonitorArguments(args: unknown): MonitorParams {
  if (!isRecord(args)) throw new Error("monitor arguments must be a JSON object.");
  const allowedRoot = ["source", "options", ...legacySourceKeys, ...optionKeys];
  rejectUnknown(args, allowedRoot, "top-level");
  const rawSource = args.source === undefined || args.source === null ? legacySource(args) : args.source;
  return { source: normalizeSource(rawSource), options: normalizeOptions(args.options, args) };
}

function requireText(source: MonitorSource, key: keyof MonitorSource): string {
  const value = source[key];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(
    `monitor source.type=${JSON.stringify(source.type)} requires source.${String(key)} to be a non-empty string. `
    + `Example: ${sourceExample(source.type)}`,
  );
}

function compactOptions(options: MonitorOptions | null): Record<string, unknown> {
  if (!options) return {};
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== null));
}

function resolvedExpiry(options: MonitorOptions | null): string | undefined {
  if (options?.expiresAt) {
    if (!Number.isFinite(Date.parse(options.expiresAt))) {
      throw new Error(`monitor options.expiresAt must be a valid ISO-8601 timestamp; received ${JSON.stringify(options.expiresAt)}.`);
    }
    return new Date(options.expiresAt).toISOString();
  }
  return options?.timeoutSeconds ? new Date(Date.now() + options.timeoutSeconds * 1000).toISOString() : undefined;
}

function probeSource(source: MonitorSource): Probe {
  if (source.type === "process") {
    if (source.processBy !== "pidFile" && source.processBy !== "match") {
      throw new Error(
        `monitor source.type="process" requires source.processBy="pidFile" or "match". `
        + `This selector prevents strict providers from fabricating both identities. Example: ${sourceExample("process")}`,
      );
    }
    const key = source.processBy;
    const value = requireText(source, key);
    return { type: "process", [key]: value } as Probe;
  }
  if (source.type === "file") return { type: "file", path: requireText(source, "path"), ...(source.tailLines ? { tailLines: source.tailLines } : {}) };
  if (source.type === "ssh") return { type: "ssh", host: requireText(source, "host"), command: requireText(source, "command") };
  if (source.type === "http") return { type: "http", url: requireText(source, "url"), ...(source.method ? { method: source.method } : {}) };
  throw new Error(`monitor internal input error: ${source.type} is not a structured probe.`);
}

export function resolveMonitorInput(params: MonitorParams, fallbackCwd: string): ResolvedMonitorInput {
  const source = params.source;
  const optionValues = compactOptions(params.options);
  delete optionValues.timeoutSeconds;
  const config = { ...optionValues, cwd: optionValues.cwd || fallbackCwd, expiresAt: resolvedExpiry(params.options) } as LaunchInput;
  if (source.type === "spawn") config.command = requireText(source, "command");
  else if (source.type === "poll") {
    config.command = requireText(source, "command");
    config.intervalSeconds = source.intervalSeconds ?? 30;
  } else if (source.type === "tail") config.logFile = requireText(source, "path");
  else {
    config.probe = probeSource(source);
    if (["process", "ssh", "http"].includes(source.type)) config.intervalSeconds = source.intervalSeconds ?? 30;
  }
  const relevant: Record<SourceType, readonly string[]> = {
    spawn: ["command"], poll: ["command", "intervalSeconds"], tail: ["path"],
    process: ["processBy", source.processBy === "match" ? "match" : "pidFile", "intervalSeconds"],
    file: ["path", "tailLines"], ssh: ["host", "command", "intervalSeconds"],
    http: ["url", "method", "intervalSeconds"],
  };
  const ignoredSourceFields = sourceValueKeys.filter((key) => !relevant[source.type].includes(key) && source[key] !== null);
  return { config, sourceType: source.type, ignoredSourceFields };
}
