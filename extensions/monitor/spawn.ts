import { spawnOwned, stopOwned, type OwnedProcess } from "./process.ts";
import type { RuntimeWatcher } from "./types.ts";

export interface SpawnRuntimeOptions {
  watcher: RuntimeWatcher;
  command: string;
  push: (line: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onFailure: (message: string) => void;
}

export interface SpawnController {
  stop: () => Promise<void>;
}

export function startSpawnRuntime(options: SpawnRuntimeOptions): SpawnController {
  const watcher = options.watcher;
  let owned: OwnedProcess | undefined;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stopped = false;
  const consume = (kind: "stdout" | "stderr", chunk: Buffer) => {
    let value = (kind === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString();
    const lines = value.split("\n");
    value = lines.pop() ?? "";
    if (kind === "stdout") stdoutBuffer = value;
    else stderrBuffer = value;
    for (const line of lines) if (line.trim()) options.push(line);
  };
  try {
    owned = spawnOwned({
      logicalId: watcher.logicalId,
      ownerEpoch: watcher.owner?.ownerEpoch ?? "unowned",
      command: options.command,
      cwd: watcher.config.cwd,
      onStdout: (chunk) => consume("stdout", chunk),
      onStderr: (chunk) => consume("stderr", chunk),
    });
    watcher.child = owned.child;
    watcher.receipt = owned.receipt;
    owned.child.once("error", (error) => options.onFailure(`SPAWN ERROR: ${error.message}`));
    owned.child.once("exit", (code, signal) => {
      if (stdoutBuffer.trim()) options.push(stdoutBuffer);
      if (stderrBuffer.trim()) options.push(stderrBuffer);
      watcher.child = undefined;
      options.onExit(code, signal);
    });
  } catch (error) { options.onFailure(`FAILED TO SPAWN: ${(error as Error).message}`); }
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (owned) await stopOwned(owned);
      watcher.child = undefined;
    },
  };
}
