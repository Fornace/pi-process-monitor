import { notify, registerMessageUI, renderMessage } from "./message-ui.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MonitorRuntime } from "./runtime.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";

export default function monitorExtension(pi: ExtensionAPI): void {
  registerMessageUI(pi);
  const runtime = new MonitorRuntime(pi);
  registerTools(pi, runtime);
  registerCommands(pi, runtime);

  pi.registerMessageRenderer("monitor", (message, options, theme) => {
    const value = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return renderMessage(pi, value, theme, { expanded: options.expanded });
  });

  pi.on("session_start", async (_event, ctx) => {
    try { await runtime.startSession(ctx); }
    catch (error) { notify(pi, ctx, `monitor recovery failed closed: ${(error as Error).message}`, "error"); }
  });

  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });
}
