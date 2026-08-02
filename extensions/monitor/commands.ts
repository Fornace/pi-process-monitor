import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MonitorRuntime } from "./runtime.ts";

function parseTokens(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      token += char;
    } else if (!quote && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
    } else token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function option(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(name);
  return index >= 0 ? tokens[index + 1] : undefined;
}

export function registerCommands(pi: ExtensionAPI, runtime: MonitorRuntime): void {
  pi.registerCommand("monitor", {
    description: "Start/reuse a watcher. Poll mode is observation only: /monitor --poll --every 30 -- ssh host 'tail ...'",
    handler: async (args, ctx) => {
      const tokens = parseTokens(args.trim());
      if (!tokens.length) { ctx.ui.notify("Usage: /monitor [--poll --every N | --file PATH] [--expires ISO | --timeout N] -- SOURCE", "info"); return; }
      const poll = tokens.includes("--poll");
      const file = option(tokens, "--file");
      const separator = tokens.indexOf("--");
      const commandTokens = separator >= 0 ? tokens.slice(separator + 1) : tokens.filter((token, index) => {
        const prior = tokens[index - 1];
        return !["--poll"].includes(token) && !["--every", "--file", "--expires", "--timeout", "--reuse-key"].includes(prior ?? "")
          && !["--every", "--file", "--expires", "--timeout", "--reuse-key"].includes(token);
      });
      const command = commandTokens.join(" ");
      try {
        const result = await runtime.launch({
          command: file ? undefined : command,
          logFile: file,
          intervalSeconds: poll ? Number(option(tokens, "--every") ?? 30) : undefined,
          cwd: ctx.cwd,
          expiresAt: option(tokens, "--expires") ?? (option(tokens, "--timeout") ? new Date(Date.now() + Number(option(tokens, "--timeout")) * 1000).toISOString() : undefined),
          reuseKey: option(tokens, "--reuse-key"),
          safetyClass: poll ? "auto" : undefined,
          label: file?.split("/").at(-1) ?? commandTokens.slice(0, 2).join(" "),
        });
        ctx.ui.notify(`${result.action}: ${result.watcher.handleId} [${result.watcher.mode}] state=${result.watcher.state}${result.reason ? ` · ${result.reason}` : ""}`, result.action === "quarantined" ? "warning" : "info");
      } catch (error) { ctx.ui.notify(`monitor: ${(error as Error).message}`, "error"); }
    },
  });

  pi.registerCommand("monitors", {
    description: "List active and quarantined logical watchers",
    handler: async (_args, ctx) => {
      if (!runtime.watchers.size) { ctx.ui.notify("No watchers.", "info"); return; }
      for (const watcher of runtime.watchers.values()) {
        ctx.ui.notify(`${watcher.handleId} · ${watcher.logicalId.slice(0, 8)} [${watcher.mode}] state=${watcher.state} owner=${watcher.owner?.runtimeId ?? "none"} failures=${watcher.consecutiveFailures}`, "info");
      }
    },
  });

  const completions = (prefix: string): AutocompleteItem[] | null => {
    const items = [...runtime.watchers.values()].filter((watcher) => watcher.handleId.startsWith(prefix) || watcher.logicalId.startsWith(prefix))
      .map((watcher) => ({ value: watcher.handleId, label: watcher.handleId, description: `${watcher.mode} · ${watcher.state}${watcher.label ? ` · ${watcher.label}` : ""}` }));
    return items.length ? items : null;
  };

  pi.registerCommand("monitor-kill", {
    description: "Stop one watcher and its extension-owned process group",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const watcher = runtime.find(args.trim());
      if (!watcher || watcher.foreignOwner) { ctx.ui.notify(watcher ? `Watcher ${watcher.handleId} is owned by another live runtime; not stopped.` : `No watcher ${args.trim()}.`, "warning"); return; }
      await watcher.stop("stop");
      ctx.ui.notify(`Stopped ${watcher.handleId}; cleanup=${watcher.receipt?.cleanupVerified ?? "n/a"}.`, "info");
    },
  });

  pi.registerCommand("monitor-recover", {
    description: "Approve/reject quarantined watcher: /monitor-recover <id> approve|reject",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const [id, action] = args.trim().split(/\s+/, 2);
      if (!id || !["approve", "reject"].includes(action ?? "")) { ctx.ui.notify("Usage: /monitor-recover <id> approve|reject", "info"); return; }
      const result = await runtime.recover(id, action === "approve");
      ctx.ui.notify(result ? `${result.action}: ${result.watcher.handleId}` : `${action}: ${id}`, "info");
    },
  });

  pi.registerCommand("monitor-gc", {
    description: "Append a compact state checkpoint: /monitor-gc [--apply]",
    handler: async (args, ctx) => {
      if (!args.includes("--apply")) { ctx.ui.notify("monitor GC is dry-run by default; use /monitor-gc --apply to append a checkpoint.", "info"); return; }
      await runtime.checkpoint();
      ctx.ui.notify("monitor GC checkpoint appended.", "info");
    },
  });
}
