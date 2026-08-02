// Minimal reproduction fixture for an effectively installed pre-v2 monitor.
export const installedVersion = "1.2.0";
export function recover(ctx, pi) {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.customType === "monitor-watcher") pi.appendEntry("monitor-watcher", entry.data);
  }
}
