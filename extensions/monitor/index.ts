import { notify, registerMessageUI, renderMessage } from "./message-ui.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MonitorRuntime } from "./runtime.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";

// A resource handoff is process-local and bound to the exact native manager.
// A fresh extension API consumes it; no old UI/context survives reload.
const key = Symbol.for("pi-process-monitor.reload-resources.v1");
const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
const handoffs = (host[key] ??= new WeakMap<object, MonitorRuntime>()) as WeakMap<object, MonitorRuntime>;

export default function monitorExtension(pi: ExtensionAPI): void {
  registerMessageUI(pi);
  let runtime = new MonitorRuntime(pi);
  registerTools(pi, () => runtime);
  registerCommands(pi, () => runtime);

  pi.registerMessageRenderer("monitor", (message, options, theme) => {
    const value = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return renderMessage(value, theme, { expanded: options.expanded });
  });

  pi.on("session_start", async (event, ctx) => {
    try {
      const retained = handoffs.get(ctx.sessionManager);
      if (retained && event.reason === "reload") {
        runtime = retained;
        runtime.resumeAfterReload(pi, ctx);
        handoffs.delete(ctx.sessionManager);
      } else {
        if (retained) throw new Error("Monitor resources await reload of their original session");
        await runtime.startSession(ctx);
      }
    } catch (error) { notify(pi, ctx, `monitor recovery failed closed: ${(error as Error).message}`, "error"); throw error; }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") {
      const retained = handoffs.get(ctx.sessionManager);
      if (retained && retained !== runtime) throw new Error("Another monitor runtime owns this session reload handoff");
      await runtime.pauseForReload();
      handoffs.set(ctx.sessionManager, runtime);
      return;
    }
    await runtime.shutdown(event.reason);
  });
}
