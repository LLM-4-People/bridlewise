import { cpSync, existsSync, renameSync, rmSync } from "node:fs";

import { HarnessError } from "../kernel/errors.ts";
import { assertCheckoutWriteAllowed } from "./checkout-write-door.ts";

// MOVING A PATH — the one owner of move operations (the web server's editor,
// its database files and its key tool move through it). Replacing a file's
// CONTENTS atomically is NOT here: that is the atomic-write owner
// (`atomic-write.ts`). A move writes TWO places — it removes the source and
// creates the destination — so BOTH are asked of the checkout write door
// (a move out of, or into, a checkout under test is a write to it; the
// server-side copy of this module asked neither: wf1c-design M-1).

/**
 * Move a file or directory tree. On one filesystem this is the kernel's
 * single atomic `rename`; across devices (EXDEV) it becomes a recursive copy
 * followed by a VERIFIED removal of the original — a copy that did not land
 * leaves the original in place and is reported, never mistaken for a
 * completed move.
 */
export function movePath(sourcePath: string, destPath: string): void {
  assertCheckoutWriteAllowed(sourcePath);
  assertCheckoutWriteAllowed(destPath);
  try {
    renameSync(sourcePath, destPath);
    return;
  } catch (err) {
    if (!isExdev(err)) throw err;
  }
  cpSync(sourcePath, destPath, { recursive: true });
  if (!existsSync(destPath)) {
    throw new HarnessError(`Move did not land — original left in place: ${sourcePath} -> ${destPath}`, "move_did_not_land");
  }
  rmSync(sourcePath, { recursive: true });
}

function isExdev(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "EXDEV";
}
