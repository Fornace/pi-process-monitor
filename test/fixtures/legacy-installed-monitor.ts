// Minimal reproduction fixture for an effectively installed pre-v2 monitor.
export const installedVersion = "1.2.0";
export function recover(ctx: { sessionManager: { getEntries(): Array<{ customType?: string; data?: unknown }> } }, pi: { appendEntry(type: string, data: unknown): void }) {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.customType === "monitor-watcher") pi.appendEntry("monitor-watcher", entry.data);
  }
}
