import { spawnOwned, stopOwned, type OwnedProcess } from "./process.ts";
import { samplePressure, type PressureSample } from "./pressure.ts";
import type { Clock, RuntimeWatcher } from "./types.ts";
import { systemClock } from "./types.ts";

export interface PollRuntimeOptions {
  watcher: RuntimeWatcher;
  command: string;
  matcher: (line: string) => boolean;
  push: (line: string) => void;
  onFailure: (message: string) => void;
  onCriticalPressure: (sample: PressureSample) => void;
  ownedChildren: () => number;
  pressureSample?: (ownedChildren: number) => Promise<PressureSample>;
  random?: () => number;
  clock?: Clock;
}

export interface PollController {
  stop: () => Promise<void>;
  tickNow: () => Promise<void>;
  isRunning: () => boolean;
}

function jittered(baseMs: number, random: () => number): number {
  return Math.max(100, Math.round(baseMs * (0.9 + random() * 0.2)));
}

export function startPollRuntime(options: PollRuntimeOptions): PollController {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const pressureSample = options.pressureSample ?? samplePressure;
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
  let tickPending = false;
  let timer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let stopped = false;
  let delayedNotice = false;
  const timeoutOwned = new WeakSet<OwnedProcess>();

  const schedule = (delay: number) => {
    if (stopped) return;
    watcher.nextTickAt = clock.now() + delay;
    timer = clock.setTimeout(() => { void tick(); }, jittered(delay, random));
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
    if (stopped || active || tickPending) return;
    tickPending = true;
    try {
      const pressure = await pressureSample(options.ownedChildren());
      if (stopped || active) return;
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
      watcher.lastTickAt = clock.now();
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
      timeout = clock.setTimeout(() => {
        const owned = active;
        if (!owned) return;
        timeoutOwned.add(owned);
        void stopOwned(owned, { termGraceMs: 1000, killGraceMs: 1000 }).then(() => {
          active = undefined;
          watcher.child = undefined;
          fail(`POLL TIMEOUT after ${timeoutMs / 1000}s; owned process group stopped`);
        });
      }, timeoutMs);
      timeout.unref?.();
      const started = active;
      started.child.once("error", (error) => {
        if (timeout) clock.clearTimeout(timeout);
        active = undefined;
        watcher.child = undefined;
        if (!timeoutOwned.has(started)) fail(`POLL ERROR: ${error.message}`);
      });
      started.child.once("exit", (code, signal) => {
        if (timeout) clock.clearTimeout(timeout);
        timeout = undefined;
        if (active === started) active = undefined;
        watcher.child = undefined;
        if (stopped || timeoutOwned.has(started)) return;
        if (code === 0) {
          watcher.consecutiveFailures = 0;
          schedule(intervalMs);
        } else fail(`POLL EXIT code=${code} signal=${signal ?? "none"}`);
      });
      } catch (error) { active = undefined; fail(`POLL SPAWN ERROR: ${(error as Error).message}`); }
    } finally { tickPending = false; }
  };

  void tick();
  return {
    tickNow: tick,
    isRunning: () => Boolean(active),
    stop: async () => {
      if (stopped && !active) return;
      stopped = true;
      if (timer) clock.clearTimeout(timer);
      if (timeout) clock.clearTimeout(timeout);
      const owned = active;
      active = undefined;
      if (owned) await stopOwned(owned);
      watcher.child = undefined;
    },
  };
}
