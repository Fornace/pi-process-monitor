import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { gcLeaseFile, inspectLeaseFile } from "./leases.ts";

export interface GcPlan {
  scanned: number;
  live: string[];
  stale: string[];
  corrupt: string[];
  emptyDirectories: string[];
}

async function walk(root: string, plan: GcPlan, apply: boolean): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  if (!entries.length) { plan.emptyDirectories.push(root); return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { await walk(path, plan, apply); continue; }
    if (!entry.name.endsWith(".lease")) continue;
    plan.scanned++;
    if (!apply) {
      const result = await inspectLeaseFile(path);
      if (result === "live") plan.live.push(path);
      else if (result === "stale") plan.stale.push(path);
      else plan.corrupt.push(path);
      continue;
    }
    const result = await gcLeaseFile(path);
    if (result === "live") plan.live.push(path);
    else if (result === "removed") plan.stale.push(path);
    else if (result === "corrupt") plan.corrupt.push(path);
  }
}

export async function planExternalGc(root: string, apply = false): Promise<GcPlan> {
  const plan: GcPlan = { scanned: 0, live: [], stale: [], corrupt: [], emptyDirectories: [] };
  await walk(root, plan, apply);
  return plan;
}

export async function applyEmptyDirectoryGc(plan: GcPlan): Promise<number> {
  let removed = 0;
  for (const path of [...plan.emptyDirectories].sort((a, b) => b.length - a.length)) {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) continue;
      await rm(path, { recursive: false });
      removed++;
    } catch { /* directory changed or is not empty */ }
  }
  return removed;
}
