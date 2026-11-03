import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawnOwned, stopOwned, type OwnedProcess } from "./process.ts";
import { samplePressure, type PressureSample } from "./pressure.ts";
import type { Clock, RuntimeWatcher } from "./types.ts";
import { systemClock } from "./types.ts";

export interface PollRuntimeOptions {
  watcher: RuntimeWatcher;
  command: string;
  matcher: (line: string) => boolean;
  push: (line: string) => void;
  flush?: () => void;
  onFailure: (message: string) => void;
  onCriticalPressure: (sample: PressureSample) => void;
  ownedChildren: () => number;
  pressureSample?: (ownedChildren: number) => Promise<PressureSample>;
  checkpointPath?: string;
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
  if (options.checkpointPath) {
    try {
      const checkpoint = JSON.parse(readFileSync(options.checkpointPath, "utf8")) as {
        version?: number; logicalId?: string; sourceFingerprint?: string; lines?: unknown;
      };
      if (checkpoint.version !== 1 || checkpoint.logicalId !== watcher.logicalId ||
          checkpoint.sourceFingerprint !== watcher.sourceFingerprint || !Array.isArray(checkpoint.lines) ||
          checkpoint.lines.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
        throw new Error("invalid poll checkpoint identity or contents");
      }
      for (const value of checkpoint.lines) seen.add(value as string);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const remember = (current: Set<string>) => {
    if (options.checkpointPath) {
      mkdirSync(dirname(options.checkpointPath), { recursive: true, mode: 0o700 });
      const temp = `${options.checkpointPath}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify({ version: 1, logicalId: watcher.logicalId,
          sourceFingerprint: watcher.sourceFingerprint, lines: [...current] })}\n`, { mode: 0o600 });
        renameSync(temp, options.checkpointPath);
      } catch (error) {
        try { unlinkSync(temp); } catch { /* no temporary file remains */ }
        throw error;
      }
    }
    seen.clear();
    for (const value of current) seen.add(value);
  };
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
      const current = new Set<string>();
      // Deliver after the full poll, so chunk boundaries cannot split an event.
      const additions: string[] = [];
      const line = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed || !options.matcher(trimmed)) return;
        const digest = createHash("sha256").update(trimmed).digest("hex");
        if (current.has(digest)) return;
        current.add(digest);
        if (!seen.has(digest)) additions.push(trimmed);
      };
      const makeConsumer = () => {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        return {
          consume(chunk: Buffer) {
            pending += decoder.write(chunk);
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const value of lines) line(value);
          },
          finish() {
            pending += decoder.end();
            if (pending) line(pending);
            pending = "";
          },
        };
      };
      const stdout = makeConsumer();
      const stderr = makeConsumer();
      active = spawnOwned({
        logicalId: watcher.logicalId,
        ownerEpoch: watcher.owner?.ownerEpoch ?? "unowned",
        command: options.command,
        cwd: watcher.config.cwd,
        onStdout: stdout.consume,
        onStderr: stderr.consume,
      });
      watcher.child = active.child;
      watcher.receipt = active.receipt;
      watcher.receipts.push(active.receipt);
      if (watcher.receipts.length > 100) watcher.receipts.shift();
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
      // close fires after both pipes drain; exit can precede their final data.
      started.child.once("close", (code, signal) => {
        if (timeout) clock.clearTimeout(timeout);
        timeout = undefined;
        if (active === started) active = undefined;
        watcher.child = undefined;
        if (stopped || timeoutOwned.has(started)) return;
        stdout.finish();
        stderr.finish();
        try {
          for (const value of additions) options.push(value);
          options.flush?.();
        } catch (error) {
          fail(`POLL NOTIFICATION ERROR: ${(error as Error).message}`);
          return;
        }
        // Retry a failed or incomplete observation against the prior snapshot.
        if (code === 0 && !started.receipt.stdoutTruncatedBytes && !started.receipt.stderrTruncatedBytes) {
          try { remember(current); }
          catch (error) {
            fail(`POLL CHECKPOINT ERROR: ${(error as Error).message}`);
            return;
          }
        }
        if (code === 0 && (started.receipt.stdoutTruncatedBytes || started.receipt.stderrTruncatedBytes)) {
          fail(`POLL OUTPUT TRUNCATED stdout=${started.receipt.stdoutTruncatedBytes} stderr=${started.receipt.stderrTruncatedBytes}`);
        } else if (code === 0) {
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
