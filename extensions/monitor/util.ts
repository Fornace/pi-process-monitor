import { truncateTail } from "@earendil-works/pi-coding-agent";

export const DEFAULT_NOTIFY = [
  "error", "fail", "failed", "oom", "out of memory", "killed", "traceback",
  "exception", "fatal", "abort", "panic", "segfault", "saved", "checkpoint",
  "complete", "completed", "done", "finished", "ready", "started", "listening",
  "success", "\\bok\\b", "✓", "✔",
];

export function compileMatchers(notifyOn?: string[]): (line: string) => boolean {
  const patterns = notifyOn?.length ? notifyOn : DEFAULT_NOTIFY;
  const matchers = patterns.map((pattern) => {
    try { return new RegExp(pattern, "i"); }
    catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  });
  return (line) => matchers.some((matcher) => matcher.test(line));
}

export interface Coalescer {
  push: (line: string) => void;
  flush: () => void;
  cancel: () => void;
}

export function createCoalescer(
  emit: (body: string) => void, coalesceSeconds = 2, maxLines = 20,
): Coalescer {
  let lines: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let canceled = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (canceled || !lines.length) return;
    const content = truncateTail(lines.join("\n"), { maxLines, maxBytes: 8000 }).content;
    lines = [];
    emit(content);
  };
  return {
    push: (line) => {
      if (canceled) return;
      lines.push(line);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, Math.max(0, coalesceSeconds) * 1000);
      timer.unref?.();
    },
    flush,
    cancel: () => {
      canceled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      lines = [];
    },
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function probeCommand(config: import("./types.ts").WatcherConfig): string | undefined {
  if (!config.probe) return config.command;
  const probe = config.probe;
  if (probe.type === "file") return `tail -n ${Math.max(1, probe.tailLines ?? 20)} -- ${shellQuote(probe.path)}`;
  if (probe.type === "process") {
    if (probe.pidFile) return `pid=$(cat -- ${shellQuote(probe.pidFile)}) && ps -p "$pid" -o pid=,stat=,etime=,command=`;
    if (probe.match) return `pgrep -af -- ${shellQuote(probe.match)}`;
    return undefined;
  }
  if (probe.type === "ssh") return `ssh -- ${shellQuote(probe.host)} ${shellQuote(probe.command)}`;
  return `curl --fail --silent --show-error --max-time 10 -X ${probe.method ?? "GET"} -- ${shellQuote(probe.url)}`;
}
