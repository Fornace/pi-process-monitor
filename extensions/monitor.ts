/**
 * monitor.ts — non-blocking background watcher for pi.
 *
 * The pi equivalent of Claude Code's `Monitor` tool. Start a long-running job
 * (or poll an SSH/remote command, or tail a log file) and the session is
 * **pinged** the moment something interesting happens — without blocking. The
 * tool returns immediately; when a matching line / process exit / heartbeat
 * fires, the extension injects a message that wakes the idle agent (or queues
 * as a steer if you're mid-chat).
 *
 * DELIBERATE DIVERGENCE from Claude's Monitor: Claude streams EVERY stdout
 * line as an event (= one LLM turn per line: expensive, floods context). This
 * extension does *conditional delivery*: only lines matching `notifyOn`
 * (default: milestones + failures), plus process exit, are pushed — and rapid
 * lines are coalesced into one message.
 *
 * Sources (pick one):
 *   command            -> spawn once, tail stdout until exit (spawn)
 *   command + interval -> re-run every N s (poll; ideal for SSH/remote)
 *   logFile            -> watch a file for appended lines (file)
 *
 * Persistence: poll & file watchers survive a pi restart (within the same
 * session) via appendEntry; spawn-mode children die with the session. A re-
 * attached watcher announces itself so you know it resumed.
 *
 * Registers:
 *   tools:    monitor, monitor_status, monitor_kill
 *   commands: /monitor <cmd>, /monitors, /monitor-kill <id>  (kill autocompletes live ids)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { Type, type Static } from "typebox";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Lines surfaced by default (case-insensitive regex). Override per-call via notifyOn.
const DEFAULT_NOTIFY = [
  "error", "fail", "failed", "oom", "out of memory", "killed", "traceback",
  "exception", "fatal", "abort", "panic", "segfault",
  "saved", "checkpoint", "complete", "completed", "done", "finished",
  "ready", "started", "listening", "success", "\\bok\\b", "✓", "✔",
];

interface WatcherResume { command?: string; logFile?: string; intervalSec?: number; cwd: string; notifyOn?: string[]; heartbeatMinutes?: number; coalesceSeconds?: number; maxLines?: number; timeoutSeconds?: number }
  interface PersistedWatcher extends WatcherResume { id?: string; stopped?: boolean }

  interface Watcher {
    id: string;
  label: string;
  mode: "spawn" | "poll" | "file";
  watchingFor: string;
  startedAt: number;
  lastEventAt: number | null;
  eventCount: number;
  alive: boolean;
  killed: boolean;
  // Everything needed to re-attach poll/file watchers after a restart:
    resume?: WatcherResume;
    persistedStop?: () => void;
    stop: () => void; // idempotent teardown
}

interface WatcherMeta {
  id: string; label: string; mode: Watcher["mode"]; watchingFor: string;
  startedAt: string; lastEventAt: string | null; eventCount: number; alive: boolean;
}
type TextBlock = { type: "text"; text: string };

export default function (pi: ExtensionAPI) {
  const watchers = new Map<string, Watcher>();
  let shuttingDown = false;
  const randId = () => Math.random().toString(36).slice(2, 11);
  const meta = (w: Watcher): WatcherMeta => ({
    id: w.id, label: w.label, mode: w.mode, watchingFor: w.watchingFor,
    startedAt: new Date(w.startedAt).toISOString(),
    lastEventAt: w.lastEventAt ? new Date(w.lastEventAt).toISOString() : null,
    eventCount: w.eventCount, alive: w.alive,
  });
  const labelTag = (w: Watcher) => `${w.id}${w.label ? " · " + w.label : ""}`;

  // Inject one coalesced event message. triggerTurn wakes an idle agent;
  // deliverAs:"steer" queues safely if mid-stream. Never throws.
  function emit(w: Watcher, body: string) {
    w.lastEventAt = Date.now();
    w.eventCount++;
    pi.sendMessage(
      { customType: "monitor", content: `[watcher ${labelTag(w)}] ${body}`, display: true, details: { id: w.id } },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  type Coalescer = ((line: string) => void) & { cancel: () => void; flush: () => void };
  function makeCoalescer(w: Watcher, coalesceMs: number, maxLines: number): Coalescer {
    let buf: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let canceled = false;
    const flush = () => {
      timer = null;
      if (canceled || !buf.length) return;
      const { content } = truncateTail(buf.join("\n"), { maxLines, maxBytes: 8000 });
      buf = [];
      emit(w, content);
    };
    const push = ((line: string) => {
      if (canceled) return;
      buf.push(line);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, coalesceMs);
    }) as Coalescer;
    push.flush = flush;
    push.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      buf = [];
      canceled = true;
    };
    return push;
  }

  const compileMatchers = (notifyOn?: string[]): ((l: string) => boolean) => {
    const pats = (notifyOn && notifyOn.length ? notifyOn : DEFAULT_NOTIFY)
      .map((p) => { try { return new RegExp(p, "i"); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } });
    return (line: string) => pats.some((r) => r.test(line));
  };

  // ---- spawn: run once, tail until exit ----
  function startSpawn(w: Watcher, command: string, cwd: string, push: Coalescer) {
    let child: ChildProcess;
    try { child = spawn("bash", ["-c", command], { cwd }); }
    catch (e) { emit(w, `FAILED TO SPAWN: ${(e as Error).message}`); return; }
    let buf = "";
    const onChunk = (data: Buffer | string) => {
      buf += data.toString();
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) push(l);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code, signal) => {
      if (buf.trim()) push(buf);
      w.alive = false;
      emit(w, `PROCESS EXITED (code=${code} signal=${signal ?? "none"})${w.killed ? " — killed by /monitor-kill" : ""}`);
      push.flush();
      push.cancel();
      w.stop();
    });
    child.on("error", (e) => {
      w.alive = false;
      emit(w, `SPAWN ERROR: ${e.message}`);
      push.cancel();
      w.stop();
    });
    w.stop = () => {
      w.killed = true;
      push.cancel();
      if (!child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
      }
      w.alive = false;
      watchers.delete(w.id);
    };
  }

  // ---- poll: re-run a command on an interval (SSH/remote) ----
  function startPoll(w: Watcher, command: string, cwd: string, intervalSec: number, matcher: (l: string) => boolean, push: Coalescer) {
    const seen = new Set<string>();
    let child: ChildProcess | undefined;
    let running = false;
    const tick = () => {
      if (!w.alive || w.killed || running) return;
      running = true;
      try { child = spawn("bash", ["-c", command], { cwd }); }
      catch (e) { running = false; emit(w, `POLL SPAWN ERROR: ${(e as Error).message}`); return; } // next tick retries
      child.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").map((l) => l.trim()).filter(Boolean);
        for (const l of lines) { if (!seen.has(l) && matcher(l)) push(l); }
        seen.clear(); for (const l of lines) seen.add(l); // rolling dedup window
      });
      child.on("error", (e) => emit(w, `POLL ERROR: ${e.message}`));
      child.on("exit", () => { running = false; child = undefined; });
    };
    tick();
    const iv = setInterval(tick, Math.max(2, intervalSec) * 1000);
    w.stop = () => {
      w.killed = true;
      clearInterval(iv);
      push.cancel();
      if (child && !child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      child = undefined;
      running = false;
      w.alive = false;
      watchers.delete(w.id);
    };
  }

  // ---- file: tail appended lines ----
  function startFile(w: Watcher, logFile: string, matcher: (l: string) => boolean, push: Coalescer) {
    let size = 0;
    try { size = fs.statSync(logFile).size; } catch { /* may appear later */ }
    const readNew = () => {
      let st: fs.Stats;
      try { st = fs.statSync(logFile); } catch { return; }
      if (st.size < size) size = 0;        // truncated/rotated
      if (st.size === size) return;
      const fd = fs.openSync(logFile, "r");
      try {
        const len = st.size - size;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size);
        for (const l of buf.toString().split("\n")) if (l.trim() && matcher(l)) push(l);
        size = st.size;
      } finally { fs.closeSync(fd); }
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let fw: fs.FSWatcher | undefined;
    try { fw = fs.watch(logFile, () => { clearTimeout(debounce); debounce = setTimeout(readNew, 150); }); }
    catch { /* missing: rely on backstop */ }
    const iv = setInterval(readNew, 5000);
    w.stop = () => { w.killed = true; clearInterval(iv); clearTimeout(debounce); debounce = undefined; fw?.close(); push.cancel(); w.alive = false; watchers.delete(w.id); };
  }

  // ---------------------------------------------------------------- watch builder
  // Shared by the tool and the command so behavior is identical.
  function launch(opts: {
    command?: string; intervalSec?: number; logFile?: string; notifyOn?: string[];
    heartbeatMinutes?: number; label?: string; coalesceSeconds?: number; maxLines?: number; cwd?: string;
    timeoutSeconds?: number;
  }): Watcher {
    const command = opts.command, logFile = opts.logFile, intervalSec = opts.intervalSec;
    const mode: Watcher["mode"] = logFile ? "file" : intervalSec ? "poll" : "spawn";
    const cwd = opts.cwd ?? process.cwd();
    const coalesceMs = Math.max(0, (opts.coalesceSeconds ?? 2)) * 1000;
    const maxLines = opts.maxLines ?? 20;
    const matcher = compileMatchers(opts.notifyOn);
    const watchingFor = (opts.notifyOn && opts.notifyOn.length ? opts.notifyOn.join(" | ") : "milestones/failures (default)") + (mode === "spawn" ? " + exit" : "");

    const w: Watcher = {
      id: randId(), label: opts.label ?? "", mode, watchingFor,
      startedAt: Date.now(), lastEventAt: null, eventCount: 0, alive: true, killed: false,
      stop: () => {},
    };
    const push = makeCoalescer(w, coalesceMs, maxLines);
    const dispose = () => { push.cancel(); watchers.delete(w.id); };

    if (mode === "spawn") startSpawn(w, command!, cwd, push);
    else if (mode === "poll") startPoll(w, command!, cwd, intervalSec!, matcher, push);
    else startFile(w, logFile!, matcher, push);

    if (opts.heartbeatMinutes) {
      const hb = setInterval(() => { if (w.alive && !w.killed) emit(w, `heartbeat: still running (events=${w.eventCount})`); },
        Math.max(1, opts.heartbeatMinutes) * 60000);
      const prev = w.stop; w.stop = () => { clearInterval(hb); dispose(); prev(); };
    }

    if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
      const timeoutMs = opts.timeoutSeconds * 1000;
      const tm = setTimeout(() => {
        if (w.alive && !w.killed) {
          emit(w, `TIMEOUT after ${opts.timeoutSeconds}s — auto-stopping watcher`);
          try { w.stop(); } catch { /* noop */ }
        }
      }, timeoutMs);
      const prev = w.stop; w.stop = () => { clearTimeout(tm); dispose(); prev(); };
    }

    // Persist poll/file watchers for resume (spawn children can't survive restart)
    if (mode !== "spawn") {
      w.resume = { command, logFile, intervalSec, cwd, notifyOn: opts.notifyOn, heartbeatMinutes: opts.heartbeatMinutes, coalesceSeconds: opts.coalesceSeconds, maxLines: opts.maxLines, timeoutSeconds: opts.timeoutSeconds };
      pi.appendEntry("monitor-watcher", { ...w.resume, id: w.id });
    }
    // Persist a single tombstone when a resumable watcher stops, regardless of
    // how many teardown paths (kill, timeout, shutdown) invoke stop.
    if (mode !== "spawn") {
      let tombstoned = false;
      w.persistedStop = () => {
        if (tombstoned || !w.resume) return;
        tombstoned = true;
        pi.appendEntry("monitor-watcher", { ...w.resume, id: w.id, stopped: true });
      };
    }
    const rawStop = w.stop;
    let stopped = false;
    w.stop = () => {
      if (stopped) return;
      stopped = true;
      if (!shuttingDown) persistStop(w);
      rawStop();
    };
    watchers.set(w.id, w);
    return w;
  }

  const persistStop = (w: Watcher) => {
    if (w.persistedStop) w.persistedStop();
  };

  // ---- resume poll/file watchers recorded earlier in this session ----
  function resumeKey(r: PersistedWatcher): string | undefined {
    // Legacy records have no id; canonicalize by source so a newer tombstone
    // also suppresses the corresponding legacy record.
    return r.command ? `command:${r.command}` : r.logFile ? `file:${r.logFile}` : r.id;
  }

  pi.on("session_start", async (_event, ctx) => {
    const latest = new Map<string, PersistedWatcher>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "monitor-watcher") continue;
      const r = entry.data as PersistedWatcher;
      const key = resumeKey(r);
      if (key) latest.set(key, r);
    }
    for (const r of latest.values()) {
      if (r.stopped || (!r.command && !r.logFile)) continue;
      // Skip if an in-memory watcher already covers it (avoid dupes within one process)
      const dup = [...watchers.values()].some((w) => w.resume && w.resume.command === r.command && w.resume.logFile === r.logFile && w.alive);
      if (dup) continue;
      const w = launch({ command: r.command, intervalSec: r.intervalSec, logFile: r.logFile, notifyOn: r.notifyOn, heartbeatMinutes: r.heartbeatMinutes, coalesceSeconds: r.coalesceSeconds, maxLines: r.maxLines, cwd: r.cwd, label: "(resumed)", timeoutSeconds: r.timeoutSeconds });
      ctx.ui?.notify?.(`monitor: re-attached watcher ${w.id} (${w.mode})`, "info");
    }
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    for (const w of [...watchers.values()]) {
      try {
          // Release local resources without tombstoning: poll/file watchers
          // are intentionally re-attached on the next session_start.
          w.stop();
      } catch { /* noop */ }
    }
    watchers.clear();
  });

  // ---- tidy inline rendering ----
  pi.registerMessageRenderer("monitor", (message, _opts, theme) => {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const m = /^\[watcher ([^ ]+)(?: · ([^\]]+))?\] (.*)$/.exec(text);
    if (m) return new Text(theme.fg("accent", `[watcher ${m[1]}`) + (m[2] ? theme.fg("muted", ` · ${m[2]}`) : "") + theme.fg("accent", "] ") + theme.fg("dim", m[3]), 0, 0);
    return new Text(theme.fg("accent", text), 0, 0);
  });

  // ================================================================ TOOL: monitor
  const monitorParams = Type.Object({
    command: Type.Optional(Type.String({ description: "Shell command. Spawned once & tailed (spawn); if intervalSeconds is also set, re-run every N s (poll, e.g. ssh h100 'tail -n5 log; pgrep -fc train')." })),
    intervalSeconds: Type.Optional(Type.Number({ description: "Poll interval in seconds. If set, `command` is re-run on this cadence (poll mode)." })),
    logFile: Type.Optional(Type.String({ description: "Path to a log file to tail for appended lines (file mode). Watch + 5s backstop poll." })),
    notifyOn: Type.Optional(Type.Array(Type.String(), { description: "Case-insensitive regexes. A line matching ANY is pushed. Defaults to milestones+failures (saved, complete, done, error, fail, oom, killed, traceback, …)." })),
    heartbeatMinutes: Type.Optional(Type.Number({ description: "Emit a heartbeat status every N minutes even when silent. Default: off." })),
    label: Type.Optional(Type.String({ description: "Human label for the watcher." })),
    coalesceSeconds: Type.Optional(Type.Number({ description: "Merge rapid matching lines into one message over this window. Default 2." })),
    maxLines: Type.Optional(Type.Number({ description: "Cap lines per pushed message. Default 20." })),
    cwd: Type.Optional(Type.String({ description: "Working directory for spawn/poll. Default current." })),
    timeoutSeconds: Type.Optional(Type.Number({ description: "Auto-kill the watcher after N seconds. Fires a TIMEOUT ping and stops the watcher. Default: no timeout." })),
  });
  type MonitorParams = Static<typeof monitorParams>;

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Start a NON-BLOCKING background watcher over a process, a polling command (e.g. SSH), or a log file. " +
      "Returns immediately with a watcher id. The session is pinged (you are notified; agent wakes if idle) " +
      "when a line matches notifyOn, when the process exits/fails, and on optional heartbeats. " +
      "Use for long training runs, dev servers, CI, remote SSH jobs. Pick ONE source: " +
      "`command` (spawn once), `command`+`intervalSeconds` (poll, ideal for SSH/remote), or `logFile` (tail).",
    promptSnippet: "Watch a background process/SSH/log and ping the session on milestones or failure",
    promptGuidelines: [
      "Use monitor instead of blocking bash when a job may run minutes-to-hours (training, dev server, CI, remote SSH). It returns at once with a watcher id and pings the session on matching lines or process exit — never block the session waiting.",
      "For remote jobs (e.g. an H100 training run), use monitor with `command` set to the ssh check + `intervalSeconds` (e.g. ssh box 'tail -n5 log; pgrep -fc train'), and `notifyOn` for the milestones you care about (adapter saved, step N, oom, killed).",
    ],
    parameters: monitorParams,
    async execute(_id, params: MonitorParams, _signal, _onUpdate, ctx): Promise<{ content: TextBlock[]; details: { watcher: WatcherMeta } }> {
      if (!params.command && !params.logFile) {
        return { content: [{ type: "text", text: "monitor error: provide `command` and/or `logFile`." }], details: { watcher: { id: "", label: "", mode: "spawn", watchingFor: "", startedAt: "", lastEventAt: null, eventCount: 0, alive: false } } };
      }
      const w = launch({
        command: params.command, intervalSec: params.intervalSeconds, logFile: params.logFile,
        notifyOn: params.notifyOn, heartbeatMinutes: params.heartbeatMinutes, label: params.label,
        coalesceSeconds: params.coalesceSeconds, maxLines: params.maxLines, cwd: params.cwd ?? ctx.cwd,
        timeoutSeconds: params.timeoutSeconds,
      });
      return { content: [{ type: "text", text: `Watcher ${w.id} running (mode=${w.mode}). Will ping when: ${w.watchingFor}.` }], details: { watcher: meta(w) } };
    },
  });

  // ================================================================ TOOL: monitor_status
  pi.registerTool({
    name: "monitor_status",
    label: "Monitor status",
    description: "List active background watchers with last-event time and event count.",
    parameters: Type.Object({}),
    async execute(): Promise<{ content: TextBlock[]; details: { watchers: WatcherMeta[] } }> {
      const list: WatcherMeta[] = [...watchers.values()].map(meta);
      if (!list.length) return { content: [{ type: "text", text: "No watchers." }], details: { watchers: [] } };
      const lines = list.map((m) => `- ${m.id}${m.label ? " · " + m.label : ""} [${m.mode}] alive=${m.alive} events=${m.eventCount} last=${m.lastEventAt ?? "never"} watching: ${m.watchingFor}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { watchers: list } };
    },
  });

  // ================================================================ TOOL: monitor_kill
  pi.registerTool({
    name: "monitor_kill",
    label: "Monitor kill",
    description: "Stop a background watcher by id. For spawn mode, sends SIGTERM then SIGKILL to the child.",
    parameters: Type.Object({ id: Type.String({ description: "Watcher id from monitor." }) }),
    async execute(_id, params): Promise<{ content: TextBlock[]; details: { watcher: WatcherMeta | undefined } }> {
      const w = watchers.get(params.id);
      if (!w) return { content: [{ type: "text", text: `No watcher ${params.id}.` }], details: { watcher: undefined } };
      w.stop();
      return { content: [{ type: "text", text: `Stopped ${w.id}.` }], details: { watcher: meta(w) } };
    },
  });

  // ================================================================ COMMANDS (human-facing, with autocomplete)
  // /monitor <command...>          start a spawn watcher over the command (default notifyOn)
  // /monitor --poll --every 30 -- ssh h100 'tail -n5 log'   poll mode
  // /monitor --file /path/to.log   file mode
  // /monitors                      list watchers
  // /monitor-kill <id>             stop a watcher (autocompletes live ids)
  pi.registerCommand("monitor", {
    description: "Start a background watcher over a command (default), or use --poll/--every/--file flags. Example: /monitor ssh h100 'tail -n5 log; pgrep -fc train'",
    handler: async (args, ctx) => {
      const a = args.trim();
      if (!a) { ctx.ui.notify("Usage: /monitor <command...>   (or /monitor --file <path>, /monitor --poll --every 30 -- <cmd>)", "info"); return; }
      const isPoll = /(^|\s)--poll(\s|$)/.test(a);
      const isFile = /(^|\s)--file(\s|$)/.test(a);
      const every = /--every\s+(\d+)/.exec(a);
      const timeout = /--timeout\s+(\d+)/.exec(a);
      const afterDD = a.includes(" -- ") ? a.slice(a.indexOf(" -- ") + 4) : a.replace(/(^|\s)--(?:poll|file)(\s+\S+)?/g, "").replace(/--every\s+\d+/g, "").replace(/--timeout\s+\d+/g, "").trim();
      const command = afterDD.replace(/^\s*--\s*/, "").trim();
      let w: Watcher;
      if (isFile) {
        const logFile = (/--file\s+(\S+)/.exec(a)?.[1] ?? command).trim();
        if (!logFile) { ctx.ui.notify("Usage: /monitor --file <path>", "warning"); return; }
        w = launch({ logFile, label: logFile.split("/").pop(), timeoutSeconds: timeout ? Number(timeout[1]) : undefined });
      } else if (isPoll) {
        if (!command) { ctx.ui.notify("Usage: /monitor --poll --every 30 -- <command>", "warning"); return; }
        w = launch({ command, intervalSec: every ? Number(every[1]) : 30, label: command.split(/\s+/).slice(0, 2).join(" "), timeoutSeconds: timeout ? Number(timeout[1]) : undefined });
      } else {
        if (!command) { ctx.ui.notify("Usage: /monitor <command...>", "warning"); return; }
        w = launch({ command, label: command.split(/\s+/).slice(0, 2).join(" "), timeoutSeconds: timeout ? Number(timeout[1]) : undefined });
      }
      ctx.ui.notify(`watcher ${w.id} running (${w.mode}) — will ping when: ${w.watchingFor}`, "info");
    },
  });

  pi.registerCommand("monitors", {
    description: "List active background watchers",
    handler: async (_args, ctx) => {
      const list = [...watchers.values()].map(meta);
      if (!list.length) { ctx.ui.notify("No watchers.", "info"); return; }
      for (const m of list) {
        ctx.ui.notify(`${m.id}${m.label ? " · " + m.label : ""} [${m.mode}] ${m.alive ? "alive" : "dead"} · ${m.eventCount} events · last ${m.lastEventAt ?? "never"} · ${m.watchingFor}`, "info");
      }
    },
  });

  pi.registerCommand("monitor-kill", {
    description: "Stop a background watcher by id (autocompletes live watcher ids)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = [...watchers.values()].filter((w) => w.id.startsWith(prefix))
        .map((w) => ({ value: w.id, label: w.id, description: `${w.mode}${w.label ? " · " + w.label : ""}` }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) { ctx.ui.notify("Usage: /monitor-kill <id>  (tab to autocomplete)", "warning"); return; }
      const w = watchers.get(id);
      if (!w) { ctx.ui.notify(`No watcher ${id}.`, "warning"); return; }
      w.stop();
      ctx.ui.notify(`Stopped watcher ${w.id}.`, "info");
    },
  });
}
