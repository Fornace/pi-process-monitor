import * as fs from "node:fs";
import { dirname } from "node:path";
import type { RuntimeWatcher } from "./types.ts";

export interface FileRuntimeOptions {
  watcher: RuntimeWatcher;
  matcher: (line: string) => boolean;
  push: (line: string) => void;
  onFailure: (message: string) => void;
}

export interface FileController {
  stop: () => void;
}

export function startFileRuntime(options: FileRuntimeOptions): FileController {
  const path = options.watcher.config.logFile
    ?? (options.watcher.config.probe?.type === "file" ? options.watcher.config.probe.path : undefined);
  if (!path) throw new Error("file watcher requires logFile or file probe");
  let offset = 0;
  let stopped = false;
  let native: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  try { offset = fs.statSync(path).size; } catch { /* file may appear later */ }

  const readNew = () => {
    if (stopped) return;
    let info: fs.Stats;
    try { info = fs.statSync(path); }
    catch { return; }
    if (info.size < offset) offset = 0;
    if (info.size === offset) return;
    const length = info.size - offset;
    const fd = fs.openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, 1024 * 1024));
      let position = offset;
      while (position < info.size) {
        const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytes) break;
        for (const line of buffer.subarray(0, bytes).toString().split("\n")) {
          if (line.trim() && options.matcher(line)) options.push(line);
        }
        position += bytes;
      }
      offset = info.size;
    } catch (error) {
      options.onFailure(`FILE READ ERROR: ${(error as Error).message}`);
    } finally { fs.closeSync(fd); }
  };

  const attachNative = () => {
    if (native || stopped) return;
    try {
      native = fs.watch(path, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(readNew, 150);
      });
      native.once("error", () => { native?.close(); native = undefined; });
    } catch { /* backstop retries */ }
  };
  attachNative();
  const interval = setInterval(() => { attachNative(); readNew(); }, 5000);
  interval.unref?.();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (debounce) clearTimeout(debounce);
      native?.close();
      native = undefined;
    },
  };
}

export function ensureWatchParent(path: string): void {
  fs.mkdirSync(dirname(path), { recursive: true });
}
