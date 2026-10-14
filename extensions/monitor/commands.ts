import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LaunchResult, MonitorRuntime } from "./runtime.ts";
import { notify } from "./message-ui.ts";

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

export function registerCommands(pi: ExtensionAPI, currentRuntime: () => MonitorRuntime): void {
  pi.registerCommand("monitor", {
    description: "Start/reuse a watcher. Poll mode is observation only: /monitor --poll --every 30 -- ssh host 'tail ...'",
    handler: async (args, ctx) => {
      const runtime = currentRuntime();
      const tokens = parseTokens(args.trim());
      if (!tokens.length) { notify(pi, ctx, "Usage: /monitor [--poll --every N | --file PATH] [--expires ISO | --timeout N] -- SOURCE", "info"); return; }
      const poll = tokens.includes("--poll");
      const file = option(tokens, "--file");
      const separator = tokens.indexOf("--");
      const commandTokens = separator >= 0 ? tokens.slice(separator + 1) : tokens.filter((token, index) => {
        const prior = tokens[index - 1];
        return !["--poll"].includes(token) && !["--every", "--file", "--expires", "--timeout", "--reuse-key"].includes(prior ?? "")
          && !["--every", "--file", "--expires", "--timeout", "--reuse-key"].includes(token);
      });
      const command = commandTokens.join(" ");
      let result: LaunchResult;
      try {
        result = await runtime.launch({
          command: file ? undefined : command,
          logFile: file,
          intervalSeconds: poll ? Number(option(tokens, "--every") ?? 30) : undefined,
          cwd: ctx.cwd,
          expiresAt: option(tokens, "--expires") ?? (option(tokens, "--timeout") ? new Date(Date.now() + Number(option(tokens, "--timeout")) * 1000).toISOString() : undefined),
          reuseKey: option(tokens, "--reuse-key"),
          safetyClass: poll ? "auto" : undefined,
          label: file?.split("/").at(-1) ?? commandTokens.slice(0, 2).join(" "),
        });
      } catch (error) { notify(pi, ctx, `monitor: ${(error as Error).message}`, "error"); return; }
      notify(pi, ctx, `${result.action}: ${result.watcher.handleId} [${result.watcher.mode}] state=${result.watcher.state}${result.reason ? ` · ${result.reason}` : ""}`, result.action === "quarantined" ? "warning" : "info");
    },
  });

  pi.registerCommand("monitors", {
    description: "List active and quarantined logical watchers",
    handler: async (_args, ctx) => {
      const runtime = currentRuntime();
      if (!runtime.watchers.size) { notify(pi, ctx, "No watchers.", "info"); return; }
      for (const watcher of runtime.watchers.values()) {
        notify(pi, ctx, `${watcher.handleId} · ${watcher.logicalId.slice(0, 8)} [${watcher.mode}] state=${watcher.state} owner=${watcher.owner?.runtimeId ?? "none"} failures=${watcher.consecutiveFailures}`, "info");
      }
    },
  });

  const completions = (prefix: string): AutocompleteItem[] | null => {
    const runtime = currentRuntime();
    const items = [...runtime.watchers.values()].filter((watcher) => watcher.handleId.startsWith(prefix) || watcher.logicalId.startsWith(prefix))
      .map((watcher) => ({ value: watcher.handleId, label: watcher.handleId, description: `${watcher.mode} · ${watcher.state}${watcher.label ? ` · ${watcher.label}` : ""}` }));
    return items.length ? items : null;
  };

  pi.registerCommand("monitor-kill", {
    description: "Stop one watcher and its extension-owned process group",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const runtime = currentRuntime();
      const watcher = runtime.find(args.trim());
      if (!watcher || watcher.foreignOwner) { notify(pi, ctx, watcher ? `Watcher ${watcher.handleId} is owned by another live runtime; not stopped.` : `No watcher ${args.trim()}.`, "warning"); return; }
      await watcher.stop("stop");
      notify(pi, ctx, `Stopped ${watcher.handleId}; cleanup=${watcher.receipt?.cleanupVerified ?? "n/a"}.`, "info");
    },
  });

  pi.registerCommand("monitor-recover", {
    description: "Approve/reject quarantined watcher: /monitor-recover <id> approve|reject",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const runtime = currentRuntime();
      const [id, action] = args.trim().split(/\s+/, 2);
      if (!id || !["approve", "reject"].includes(action ?? "")) { notify(pi, ctx, "Usage: /monitor-recover <id> approve|reject", "info"); return; }
      const result = await runtime.recover(id, action === "approve");
      notify(pi, ctx, result ? `${result.action}: ${result.watcher.handleId}` : `${action}: ${id}`, "info");
    },
  });

  pi.registerCommand("monitor-gc", {
    description: "Append a compact state checkpoint: /monitor-gc [--apply]",
    handler: async (args, ctx) => {
      const runtime = currentRuntime();
      if (!args.includes("--apply")) { notify(pi, ctx, "monitor GC is dry-run by default; use /monitor-gc --apply to append a checkpoint.", "info"); return; }
      await runtime.checkpoint();
      notify(pi, ctx, "monitor GC checkpoint appended.", "info");
    },
  });
}
