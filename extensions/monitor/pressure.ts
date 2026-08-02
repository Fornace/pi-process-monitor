import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { totalmem, freemem, loadavg, cpus } from "node:os";

const execFileAsync = promisify(execFile);

export type PressureLevel = "normal" | "elevated" | "critical" | "unavailable";

export interface PressureSample {
  level: PressureLevel;
  sampledAt: string;
  availableRatio?: number;
  normalizedLoad?: number;
  ownedChildren: number;
  reasons: string[];
}

export interface PressureThresholds {
  elevatedAvailableRatio: number;
  criticalAvailableRatio: number;
  elevatedNormalizedLoad: number;
  criticalNormalizedLoad: number;
  maxOwnedChildren: number;
}

export const DEFAULT_THRESHOLDS: PressureThresholds = {
  elevatedAvailableRatio: 0.12,
  criticalAvailableRatio: 0.06,
  elevatedNormalizedLoad: 1.5,
  criticalNormalizedLoad: 2.5,
  maxOwnedChildren: 8,
};

async function macMemoryPressure(): Promise<number | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("memory_pressure", [], { timeout: 1200 });
    const line = stdout.split("\n").find((value) => value.includes("System-wide memory free percentage"));
    if (!line) return undefined;
    const value = Number(line.split(":").at(-1)?.replace("%", "").trim());
    return Number.isFinite(value) ? value / 100 : undefined;
  } catch { return undefined; }
}

export async function samplePressure(
  ownedChildren: number,
  thresholds: PressureThresholds = DEFAULT_THRESHOLDS,
): Promise<PressureSample> {
  const reasons: string[] = [];
  const systemRatio = totalmem() > 0 ? freemem() / totalmem() : undefined;
  const macRatio = await macMemoryPressure();
  const availableRatio = macRatio ?? systemRatio;
  const cpuCount = Math.max(1, cpus().length);
  const normalizedLoad = loadavg()[0] / cpuCount;
  let level: PressureLevel = availableRatio === undefined ? "unavailable" : "normal";
  if (availableRatio !== undefined && availableRatio <= thresholds.criticalAvailableRatio) {
    level = "critical";
    reasons.push(`available memory ${(availableRatio * 100).toFixed(1)}%`);
  } else if (availableRatio !== undefined && availableRatio <= thresholds.elevatedAvailableRatio) {
    level = "elevated";
    reasons.push(`available memory ${(availableRatio * 100).toFixed(1)}%`);
  }
  if (normalizedLoad >= thresholds.criticalNormalizedLoad) {
    level = "critical";
    reasons.push(`normalized load ${normalizedLoad.toFixed(2)}`);
  } else if (normalizedLoad >= thresholds.elevatedNormalizedLoad && level !== "critical") {
    level = "elevated";
    reasons.push(`normalized load ${normalizedLoad.toFixed(2)}`);
  }
  if (ownedChildren >= thresholds.maxOwnedChildren) {
    level = "critical";
    reasons.push(`owned child limit ${ownedChildren}/${thresholds.maxOwnedChildren}`);
  }
  if (!reasons.length) reasons.push(level === "unavailable" ? "telemetry unavailable" : "host signals normal");
  return {
    level,
    sampledAt: new Date().toISOString(),
    availableRatio,
    normalizedLoad,
    ownedChildren,
    reasons,
  };
}
