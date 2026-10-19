import { lstatSync } from "node:fs";

import { shouldRejectHardlinks } from "../shared/source-scan.ts";

/**
 * THE SINGLE OWNER OF "does this file have a SECOND NAME, and may it be
 * reached through this one?"
 *
 * ── THE DEFECT THIS MODULE EXISTS TO MAKE IMPOSSIBLE ──────────────────────
 *
 * A hard link is a second directory entry for the same inode. Every
 * path-containment gate in this workspace resolves symbolic links and then
 * compares locations — which is correct, and which a hard link walks straight
 * past, because there is no link to follow: `realpath` on a hard link returns
 * the hard link. So a name lexically inside a root can address bytes that live
 * outside it, and a gate that only resolves is a gate that admits them.
 *
 * That question was being answered independently in five places, with the same
 * three lines written out each time (`stats.nlink !== 1n`, sometimes bigint,
 * sometimes not, sometimes policy-aware, sometimes not) — and the web UI's
 * filesystem gate, the one gate a model can drive, did not answer it at all.
 * Measured end to end before this module existed: `resolveWithinProject`
 * ADMITTED a hard link to a file outside the project and the editor bridge
 * returned its bytes, while the symbolic-link form of the same attack was
 * correctly refused three lines earlier.
 *
 * Copying the missing three lines into the sixth place would have fixed the
 * instance. One question with six implementations is the defect; the fix is
 * that there is now one, every asker consults it, and a seventh asker gets the
 * same answer without anybody remembering to.
 *
 * ── STRENGTH LADDER, and why it stopped where it did ──────────────────────
 *
 *   1. Physically impossible — NOT reachable. Landlock authorises by path
 *      HIERARCHY and has no concept of link count, so no ruleset can express
 *      "refuse a second name"; and the kernel cannot be asked "is any other
 *      name for this inode outside root R" without walking a filesystem. The
 *      link COUNT is the affordable proxy and it is a userspace read.
 *   2. Unrepresentable — NOT reachable for the same reason `ResolvedAbsolutePath`
 *      stops at rung 3: the value is a path, every path is a string, and no
 *      type can exclude "a string naming a file with two names".
 *   3. Unreachable by shape — NOT reached, and the reason is specific: the
 *      askers already funnel through their own single doors
 *      (`resolveWithinProject`, the repository reader's `readFile`), so the
 *      obligation would have to be carried by a brand on the RESULT of those
 *      doors. That is a real design and it is larger than one module: it means
 *      every filesystem call in the web server taking a branded path rather
 *      than a string, across ~46 gate entry points. Recorded as its own task
 *      rather than dismissed.
 *   4. Refused at a runtime choke point — REACHED. Each door asks this module
 *      once, on the path it just resolved, before anything opens it.
 *   5. A source-scan guard that no in-repo `nlink` verdict may be written
 *      outside this module — present as the backstop that catches a SEVENTH
 *      owner being minted, which rung 4 cannot see.
 */

/**
 * THE FACT, with no policy in it: does this inode have more than one name?
 *
 * Accepts either width because `lstatSync` returns `number` and
 * `lstatSync(…, { bigint: true })` returns `bigint`, and the mixed comparison
 * (`stats.nlink !== 1n` against a `number`) is always true — a silent
 * always-refuse that reads exactly like the correct check.
 *
 * Directories are NOT this function's business and callers must not hand one
 * in: every directory has at least two names (`.` and its entry in the
 * parent), so the answer for a directory is "yes" and it means nothing.
 * {@link pathIsRefusedSecondName} enforces that; a caller holding stats of its
 * own is responsible for the same test, which is why the policy-aware door
 * below is the one to prefer.
 */
export function hasSecondName(nlink: bigint | number): boolean {
  return typeof nlink === "bigint" ? nlink > 1n : nlink > 1;
}

/**
 * THE FACT, FROM A PATH: are the bytes this path names also reachable by
 * another name?
 *
 * ── WHY THIS EXISTS SEPARATELY FROM {@link pathIsRefusedSecondName} ───────
 *
 * TWO INVARIANTS WERE SHARING ONE SWITCH, and they are not the same question.
 *
 *   - SELF-PROTECTION asks "is the harness's OWN source tree tamper-resistant?"
 *     A developer's workspace is legitimately seeded with `cp -rl`, so every
 *     file in it has two names and refusing them would refuse the whole tree.
 *     That is what the operator opt-out is for, and it is correct.
 *   - TENANT CONTAINMENT asks "can this name reach bytes outside the project
 *     the user opened?" A hard link is the one way out that resolving cannot
 *     see, because there is no link to follow. The `cp -rl` seeding of the
 *     HARNESS's tree says nothing whatever about whether a path inside a USER's
 *     project also lives outside it.
 *
 * Routing the second question through the first meant one environment variable
 * answered both: measured end to end, `HARNESS_REJECT_HARDLINKS=0` made the web
 * UI's gate ADMIT a hard link to a file outside the project. The variable is
 * set by the CLI whenever `selfProtection.enabled` is false, and is inherited
 * by every child process — so the exposure is a developer starting the server
 * from a shell that had run a harness command. Nothing in the web repository
 * sets it, and no test could ever see the gate open, which is the point: an
 * opt-out nobody drives is an opt-out nobody has checked.
 *
 * Containment asks THIS function. It has no policy in it and nothing can turn
 * it off.
 */
export function pathHasSecondName(absPath: string): boolean {
  const stats = lstatSync(absPath, { bigint: true, throwIfNoEntry: false });
  // Same three deliberate admissions as the policy door, minus the policy: a
  // path that does not exist has no second name (a write to a new file must be
  // GATED rather than refused), and a directory's link count says nothing
  // because every directory has at least two names.
  if (stats === undefined || !stats.isFile()) return false;
  return hasSecondName(stats.nlink);
}

/**
 * THE POLICY: must a second name be refused at all?
 *
 * Delegates to the existing single owner of that decision
 * (`shouldRejectHardlinks`, which reads the production floor from
 * `ROOT_POLICY.verification.safeRepositoryRead.rejectHardlinks` and honours the
 * operator's documented dev-mode opt-out). It is re-exported through here
 * rather than re-derived, because a second reading of the same env var is a
 * second source of truth that only diverges when nobody is looking.
 */
export function refusesSecondNames(): boolean {
  return shouldRejectHardlinks();
}

/**
 * THE SELF-PROTECTION DOOR: is this path a regular file that SELF-PROTECTION
 * POLICY says must not be reached, because the bytes behind it are reachable by
 * another name?
 *
 * FOR READING THE HARNESS'S OWN TREE ONLY. A containment gate — anything asking
 * "may this user's path reach outside this user's project" — asks
 * {@link pathHasSecondName} instead, which has no opt-out, because the
 * `cp -rl` seeding this policy exists for is a fact about the harness's
 * workspace and not about anybody's project.
 *
 * Answers `false` — admits — in three cases, each deliberate:
 *
 *   - policy is off (the operator's dev-mode opt-out, e.g. a workspace seeded
 *     with `cp -rl`, where every file legitimately has two names);
 *   - the path does not exist, because a write to a file not created yet must
 *     still be GATED rather than refused, and a file that does not exist has
 *     no second name;
 *   - the path is not a regular file. A directory always has two or more
 *     names and the count says nothing; a symbolic link is a name rather than
 *     a second hard name, and where it may point is decided by the resolver
 *     before this is ever asked.
 *
 * It never throws: an unreadable path answers `false` and the caller's own
 * existence and ownership checks report it, so this cannot turn a missing file
 * into a security refusal that hides the real cause.
 */
export function pathIsRefusedSecondName(absPath: string): boolean {
  if (!refusesSecondNames()) return false;
  const stats = lstatSync(absPath, { bigint: true, throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) return false;
  return hasSecondName(stats.nlink);
}
