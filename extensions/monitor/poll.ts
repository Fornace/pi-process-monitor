import { spawnOwned, stopOwned, type OwnedProcess } from "./process.ts";
import { samplePressure, type PressureSample } from "./pressure.ts";
import type { RuntimeWatcher } from "./types.ts";

export interface PollRuntimeOptions {
  watcher: RuntimeWatcher;
  command: string;
  matcher: (line: string) => boolean;
  push: (line: string) => void;
  onFailure: (message: string) => void;
  onCriticalPressure: (sample: PressureSample) => void;
  ownedChildren: () => number;
}

export interface PollController {
  stop: () => Promise<void>;
  tickNow: () => Promise<void>;
}

function jittered(baseMs: number): number {
  return Math.max(100, Math.round(baseMs * (0.9 + Math.random() * 0.2)));
}

export function startPollRuntime(options: PollRuntimeOptions): PollController {
  const watcher = options.watcher;
  const intervalMs = Math.max(2000, (watcher.config.intervalSeconds ?? 30) * 1000);
  const timeoutMs = Math.max(250, Math.min(
    (watcher.config.pollTimeoutSeconds ?? Math.max(1, intervalMs / 1000 - 1)) * 1000,
    intervalMs - 100,
  ));
  const maxFailures = Math.max(1, watcher.config.maxConsecutiveFailures ?? 5);
  const maxBackoffMs = Math.max(intervalMs, (watcher.config.backoffMaxSeconds ?? 300) * 1000);
  const seen = new Set<string>();
  let active: OwnedProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let stopped = false;
  let delayedNotice = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    watcher.nextTickAt = Date.now() + delay;
    timer = setTimeout(() => { void tick(); }, jittered(delay));
    timer.unref?.();
  };

  const fail = (message: string) => {
    watcher.consecutiveFailures++;
    options.onFailure(message);
    if (watcher.consecutiveFailures >= maxFailures) {
      stopped = true;
      options.onFailure(`POLL SUSPENDED after ${watcher.consecutiveFailures} consecutive failures`);
      return;
    }
    schedule(Math.min(maxBackoffMs, intervalMs * (2 ** watcher.consecutiveFailures)));
  };

  const consume = (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) if (!seen.has(line) && options.matcher(line)) options.push(line);
    seen.clear();
    for (const line of lines) seen.add(line);
  };

  const tick = async () => {
    if (stopped || active) return;
    const pressure = await samplePressure(options.ownedChildren());
    if (pressure.level === "critical") {
      stopped = true;
      options.onCriticalPressure(pressure);
      return;
    }
    if (pressure.level === "elevated") {
      if (!delayedNotice) options.onFailure(`POLL DELAYED: ${pressure.reasons.join(", ")}`);
      delayedNotice = true;
      schedule(Math.min(maxBackoffMs, intervalMs * 2));
      return;
    }
    delayedNotice = false;
    watcher.lastTickAt = Date.now();
    try {
      active = spawnOwned({
        logicalId: watcher.logicalId,
        ownerEpoch: watcher.owner?.ownerEpoch ?? "unowned",
        command: options.command,
        cwd: watcher.config.cwd,
        onStdout: consume,
        onStderr: consume,
      });
      watcher.child = active.child;
      watcher.receipt = active.receipt;
      timeout = setTimeout(() => {
        const owned = active;
        if (!owned) return;
        void stopOwned(owned, { termGraceMs: 1000, killGraceMs: 1000 }).then(() => {
          active = undefined;
          watcher.child = undefined;
          fail(`POLL TIMEOUT after ${timeoutMs / 1000}s; owned process group stopped`);
        });
      }, timeoutMs);
      timeout.unref?.();
      active.child.once("error", (error) => {
        if (timeout) clearTimeout(timeout);
        active = undefined;
        watcher.child = undefined;
        fail(`POLL ERROR: ${error.message}`);
      });
      active.child.once("exit", (code, signal) => {
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        active = undefined;
        watcher.child = undefined;
        if (stopped) return;
        if (code === 0) {
          watcher.consecutiveFailures = 0;
          schedule(intervalMs);
        } else fail(`POLL EXIT code=${code} signal=${signal ?? "none"}`);
      });
    } catch (error) { active = undefined; fail(`POLL SPAWN ERROR: ${(error as Error).message}`); }
  };

  void tick();
  return {
    tickNow: tick,
    stop: async () => {
      if (stopped && !active) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (timeout) clearTimeout(timeout);
      const owned = active;
      active = undefined;
      if (owned) await stopOwned(owned);
      watcher.child = undefined;
    },
  };
}
