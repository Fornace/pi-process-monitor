import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MonitorRuntime } from "./runtime.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";

export default function monitorExtension(pi: ExtensionAPI): void {
  const runtime = new MonitorRuntime(pi);
  registerTools(pi, runtime);
  registerCommands(pi, runtime);

  pi.registerMessageRenderer("monitor", (message, _options, theme) => {
    const value = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const match = /^\[watcher ([^ ]+)(?: · ([^\]]+))?\] (.*)$/.exec(value);
    if (!match) return new Text(theme.fg("accent", value), 0, 0);
    const label = match[2] ? theme.fg("muted", ` · ${match[2]}`) : "";
    return new Text(`${theme.fg("accent", `[watcher ${match[1]}`)}${label}${theme.fg("accent", "] ")}${theme.fg("dim", match[3]!)}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    try { await runtime.startSession(ctx); }
    catch (error) { ctx.ui?.notify?.(`monitor recovery failed closed: ${(error as Error).message}`, "error"); }
  });

  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });
}
