import { createHash, randomUUID } from "node:crypto";
import { normalize, resolve } from "node:path";
import type { Probe, SafetyClass, WatcherConfig, WatcherMode } from "./types.ts";

const SHELL_OPERATORS = new Set([";", "&&", "||", "&", ">", ">>", "<", "<<", "|&"]);
const WORKLOAD_EXECUTABLES = new Set([
  "python", "python3", "swift", "xcodebuild", "make", "cmake", "ninja",
  "npm", "pnpm", "yarn", "bun", "cargo", "go", "java", "gradle", "mvn",
  "torchrun", "accelerate", "deepspeed", "convert", "ffmpeg",
]);
const WORKLOAD_VERBS = new Set([
  "build", "test", "train", "convert", "generate", "install", "run", "start",
  "serve", "compile", "package", "deploy",
]);
const OBSERVER_EXECUTABLES = new Set([
  "cat", "tail", "head", "stat", "wc", "ps", "pgrep", "grep", "rg", "find",
  "test", "ls", "du", "df", "uptime", "ssh", "curl",
]);

export function newLogicalId(): string {
  return randomUUID();
}

export function shortHandle(logicalId: string): string {
  return logicalId.replaceAll("-", "").slice(0, 9);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalPath(path: string, cwd = process.cwd()): string {
  return normalize(resolve(cwd, path));
}

function collapseWhitespace(value: string): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  let space = false;
  for (const char of value.trim()) {
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      if (space && out) out += " ";
      space = false;
      out += char;
    } else if (!quote && /\s/.test(char)) {
      space = true;
    } else {
      if (space && out) out += " ";
      space = false;
      out += char;
    }
  }
  return out;
}

export function canonicalCommand(command: string): string {
  return collapseWhitespace(command);
}

function sorted<T>(values: T[] | undefined): T[] | undefined {
  return values ? [...values].sort() : undefined;
}

export function canonicalConfig(config: WatcherConfig, mode: WatcherMode): object {
  return {
    mode,
    cwd: canonicalPath(config.cwd),
    command: config.command ? canonicalCommand(config.command) : undefined,
    logFile: config.logFile ? canonicalPath(config.logFile, config.cwd) : undefined,
    probe: canonicalProbe(config.probe, config.cwd),
    intervalSeconds: config.intervalSeconds,
    notifyOn: sorted(config.notifyOn),
    heartbeatMinutes: config.heartbeatMinutes,
    coalesceSeconds: config.coalesceSeconds ?? 2,
    maxLines: config.maxLines ?? 20,
    expiresAt: config.expiresAt,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    backoffMaxSeconds: config.backoffMaxSeconds,
    safetyClass: config.safetyClass ?? "auto",
    recoveryPolicy: config.recoveryPolicy,
    reuseKey: config.reuseKey,
  };
}

function canonicalProbe(probe: Probe | undefined, cwd: string): Probe | undefined {
  if (!probe) return undefined;
  if (probe.type === "file") return { ...probe, path: canonicalPath(probe.path, cwd) };
  if (probe.type === "ssh") return { ...probe, command: canonicalCommand(probe.command) };
  return probe;
}

export function sourceFingerprint(config: WatcherConfig, mode: WatcherMode): string {
  return sha256(JSON.stringify(canonicalConfig(config, mode)));
}

export function modeFor(config: Pick<WatcherConfig, "logFile" | "probe" | "intervalSeconds">): WatcherMode {
  if (config.logFile || config.probe?.type === "file") return "file";
  if (config.intervalSeconds || config.probe) return "poll";
  return "spawn";
}

export interface SafetyDecision {
  classification: "safe-observer" | "unsafe-shell" | "ambiguous";
  local: boolean;
  reasons: string[];
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      token += char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    if (!quote) {
      const pair = command.slice(i, i + 2);
      if (SHELL_OPERATORS.has(pair)) {
        if (token) tokens.push(token);
        tokens.push(pair);
        token = "";
        i++;
        continue;
      }
      if (SHELL_OPERATORS.has(char)) {
        if (token) tokens.push(token);
        tokens.push(char);
        token = "";
        continue;
      }
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function classifyPoll(config: WatcherConfig): SafetyDecision {
  if (config.safetyClass === "observer") return { classification: "safe-observer", local: true, reasons: ["explicit observer acknowledgement"] };
  if (config.safetyClass === "unsafe-shell") return { classification: "unsafe-shell", local: true, reasons: ["explicit unsafe-shell classification"] };
  if (config.probe) {
    const local = config.probe.type !== "ssh" && config.probe.type !== "http";
    return { classification: "safe-observer", local, reasons: [`structured ${config.probe.type} probe`] };
  }
  const command = config.command ?? "";
  const tokens = shellTokens(command);
  const executableIndex = tokens.findIndex((token) => !SHELL_OPERATORS.has(token));
  const executable = (tokens[executableIndex] ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (executable === "ssh") {
    const host = tokens[executableIndex + 1] ?? "";
    const remote = tokens.slice(executableIndex + 2).join(" ").replace(/^(['"])(.*)\1$/, "$2");
    const nested: WatcherConfig = { ...config, command: remote };
    const nestedSafety = remote ? classifyPoll(nested) : { classification: "ambiguous" as const, reasons: ["missing remote probe command"] };
    if (nestedSafety.classification === "unsafe-shell") return { classification: "unsafe-shell", local: false, reasons: nestedSafety.reasons.map((reason) => `remote ${reason}`) };
    return { classification: nestedSafety.classification === "safe-observer" ? "safe-observer" : "ambiguous", local: false, reasons: [`remote ssh probe ${host}`, ...nestedSafety.reasons] };
  }
  const reasons: string[] = [];
  if (tokens.some((token) => [";", "&&", "||", "&", ">", ">>", "<", "<<", "|&"].includes(token))) reasons.push("mutation/compound/background shell operator");
  const segmentExecutables = tokens.filter((token, index) => index === 0 || SHELL_OPERATORS.has(tokens[index - 1]!))
    .map((token) => token.replace(/^['"]|['"]$/g, "").split("/").pop()?.toLowerCase() ?? "");
  if (segmentExecutables.some((name) => WORKLOAD_EXECUTABLES.has(name))) reasons.push(`workload executable ${segmentExecutables.find((name) => WORKLOAD_EXECUTABLES.has(name))}`);
  if (WORKLOAD_EXECUTABLES.has(executable) && !reasons.some((reason) => reason.startsWith("workload executable"))) reasons.push(`workload executable ${executable}`);
  if (tokens.some((token) => WORKLOAD_VERBS.has(token.toLowerCase()))) reasons.push("workload verb");
  if (reasons.length) return { classification: "unsafe-shell", local: true, reasons };
  if (OBSERVER_EXECUTABLES.has(executable)) return { classification: "safe-observer", local: true, reasons: [`observer executable ${executable}`] };
  return { classification: "ambiguous", local: true, reasons: ["unrecognized local shell command"] };
}

export function defaultRecoveryPolicy(mode: WatcherMode, config: WatcherConfig): "never" | "confirm" | "safe-auto" {
  if (mode === "spawn") return "never";
  if (mode === "file") return "safe-auto";
  const safety = classifyPoll(config);
  return safety.local ? "confirm" : "safe-auto";
}
