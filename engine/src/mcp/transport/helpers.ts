import type { ChildProcess } from "node:child_process";

import { guarded } from "../../process/fault-policy.ts";

export function writeWithCallback(child: ChildProcess, data: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // EPIPE can arrive as an 'error' event on stdin BEFORE the write callback
    // fires. Without this listener, the event is uncaught and crashes the
    // server process. The listener is one-shot: it rejects the promise and
    // removes itself so the write callback's own reject is not a double-settle.
    const onPipeError = guarded("mcp.stdio.pipe-error", (err: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      child.stdin?.removeListener("error", onPipeError);
      reject(err);
    });
    child.stdin?.on("error", onPipeError);
    child.stdin!.write(data + "\n", guarded("mcp.stdio.write-done", (error: Error | null | undefined) => {
      if (settled) return;
      settled = true;
      child.stdin?.removeListener("error", onPipeError);
      if (error !== null && error !== undefined) reject(error);
      else resolve();
    }));
  });
}
