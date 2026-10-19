import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { InputError, SecurityError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { windowsDriveMountPoints } from "./linux-path.ts";

/**
 * THE ONE OWNER OF PATH IDENTITY: where a path really is, and whether one
 * place lies at or under another — answered by `(st_dev, st_ino)` of the
 * location and every ancestor, never by comparing spellings.
 *
 * Every consumer that decides something about a place asks here: the
 * guardian spec compiler (protected subtrees, the keep-out list, W^X), the
 * server's file choke point and project door, the atomic write door's link
 * rule and the checkout write door.
 *
 * ── WHY A BRAND, AND NOT A CONVENTION ─────────────────────────────────────
 *
 * The guardian's safety floor used to compare the STRINGS it was handed, and
 * six spellings of the same directory walked past it — `<root>/guardian/..`,
 * `//home/x`, `/home/x/.`, and a symbolic link, each of which the kernel
 * resolves to a place the floor had just refused by another name. Three of
 * them reached a WRITE inside the protected subtree while every surface still
 * reported the sandbox as enforced. So the type carries the obligation: the
 * comparisons accept only {@link ResolvedAbsolutePath}, the ONLY way to obtain
 * one is {@link resolveLocation}, and a raw string handed to a comparison is a
 * COMPILE error.
 *
 * ── WHY IDENTITY, AND NOT A RESOLVED STRING ───────────────────────────────
 *
 * A resolved path has no `..` and no symbolic link, and a string comparison of
 * two resolved paths is still wrong, because a directory can have a second
 * spelling that is not a link: a BIND MOUNT. WSL2 always exposes the distro
 * root at `/mnt/wslg/distro`, so `/mnt/wslg/distro/home/u/.ssh` is the same
 * directory as `/home/u/.ssh`, `realpath` keeps the alias, and every
 * string-based check let it through (measured under the real guardian).
 * Landlock attaches rules to inodes, so the question is the kernel's.
 *
 * A path that does not exist (yet) is located at its DEEPEST EXISTING
 * ANCESTOR plus the missing tail; a missing tail contains no mount and no
 * link, so it is compared by name under that anchor's identity —
 * case-insensitively when the anchor lies on a Windows drive (DrvFs), where
 * `.CODEX` and `.codex` are one name.
 */
declare const RESOLVED_ABSOLUTE_PATH: unique symbol;

export type ResolvedAbsolutePath = string & {
  readonly [RESOLVED_ABSOLUTE_PATH]: "resolved-absolute-path";
};

/**
 * The most segments a path may contain before the resolver gives up walking
 * up it. A Linux path is capped at 4096 bytes and every segment costs at least
 * two (`/x`), so 2048 is the precise bound; reaching it is a refusal, never a
 * stopping point (a half-resolved path is the permissive direction).
 */
const MAX_PATH_SEGMENTS = 2048;

/**
 * Turn a raw path into a {@link ResolvedAbsolutePath}, or refuse it.
 *
 * Refuses a path that is not absolute (`"~/"` and `"$HOME"` name different
 * places depending on who runs them). Resolution is two moves, in this order,
 * as the kernel does: `resolve()` collapses `.`, `..`, `//` and a trailing
 * separator (string arithmetic), then `realpathSync` on the DEEPEST EXISTING
 * ANCESTOR follows links — the deepest existing one because a rule may
 * legitimately name something not created yet; the missing tail is re-joined
 * afterwards and cannot contain a link, because it does not exist.
 */
export function resolveLocation(raw: string, what: string = "path"): ResolvedAbsolutePath {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InputError(`${what} must be a non-empty string`, "path_not_absolute");
  }
  if (!isAbsolute(raw)) {
    throw new InputError(
      `${what} must be absolute, not ${JSON.stringify(raw)} — a relative path, "~/" or "$HOME" names a different place depending on who runs it`,
      "path_not_absolute",
    );
  }
  const lexical = resolve(raw);
  let existing = lexical;
  const missingTail: string[] = [];
  let walked = false;
  for (let depth = 0; depth < MAX_PATH_SEGMENTS; depth += 1) {
    if (existsSync(existing)) {
      walked = true;
      break;
    }
    const parent = dirname(existing);
    // `dirname("/")` is `"/"`: walked to the root and the root does not exist.
    if (parent === existing) {
      walked = true;
      break;
    }
    missingTail.unshift(existing.slice(parent === "/" ? 1 : parent.length + 1));
    existing = parent;
  }
  if (!walked) {
    throw new InputError(
      `${what} has more than ${MAX_PATH_SEGMENTS} path segments, so it could not be fully resolved: ${JSON.stringify(raw.slice(0, 120))}…`,
      "path_too_deep",
    );
  }
  let anchor: string;
  try {
    anchor = realpathSync(existing);
  } catch (error) {
    // The path existed a moment ago and does not now, or a component became
    // unreadable. The lexical answer is never MORE permissive (a link can only
    // move a place elsewhere and every comparison runs both ways) — and it is
    // REPORTED, because it is the one case weaker than the promise.
    handleError(error, { module: "filesystem/path-identity", operation: "resolveLocation", path: existing, what });
    anchor = existing;
  }
  const located = withLongNames(anchor);
  return (missingTail.length === 0 ? located : join(located, ...missingTail)) as ResolvedAbsolutePath;
}

/**
 * A WINDOWS SHORT (8.3) NAME: `CODEX~1` for `.codex`, `PROGRA~3` for
 * `ProgramData`. On a Windows drive (DrvFs) the kernel opens a short name as
 * the long one (same inode, measured: `/mnt/c/Users/<u>/CODEX~1` IS
 * `.codex`), and `realpath` keeps whichever spelling it was handed — so every
 * comparison BY NAME (the keep-out list's names under a measured base) missed
 * it. A resolved spelling therefore never carries one: each short-shaped
 * segment of an existing place on a Windows drive is re-spelled as the long
 * name that has its identity.
 */
const SHORT_NAME = /^([^~.]{1,6})~\d{1,6}(?:\.[^.]{0,3})?$/u;

/** The name part Windows builds a short name from: upper case, no spaces or dots (the extension dropped). */
function shortNameBasis(name: string): string {
  const withoutExtension = name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name;
  return withoutExtension.toUpperCase().replace(/[. ]/gu, "");
}

function onWindowsDrive(path: string): boolean {
  return windowsDriveMountPoints().some((root) => spelledAtOrUnder(path, root));
}

/** `anchor` (an existing, realpath'd place) with every short-named segment on a Windows drive spelled long. */
function withLongNames(anchor: string): string {
  if (!anchor.includes("~") || !onWindowsDrive(anchor)) return anchor;
  const segments = anchor.split("/");
  let current = "";
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const match = SHORT_NAME.exec(segment);
    if (match !== null && onWindowsDrive(current.length === 0 ? "/" : current)) {
      segments[index] = longNameOf(current.length === 0 ? "/" : current, segment, (match[1] ?? "").toUpperCase());
    }
    current = `${current}/${segments[index]}`;
  }
  return segments.join("/");
}

/**
 * The long name in `folder` that IS `short` (same device and inode), tried
 * among the entries it can abbreviate: those whose basis starts with the short
 * name's (`CODEX~1` ← `.codex`), then — for a name Windows hashed after many
 * collisions (`PR3A5F~1`: two characters, a hash) — those sharing its first
 * two characters. Each is measured once. A name that only looks short (a real
 * `backup~1`) is its own long name.
 */
/** A hashed 8.3 name keeps this many characters of its long name before the hash (the Windows format, `PR3A5F~1`). */
const HASHED_SHORT_NAME_KEPT_CHARACTERS = 2;

function longNameOf(folder: string, short: string, basis: string): string {
  const identity = identityOf(join(folder, short));
  if (identity === undefined) return short;
  let names: readonly string[];
  try { names = readdirSync(folder); } catch { return short; }
  const others = names.filter((name) => name !== short);
  const likely = others.filter((name) => shortNameBasis(name).startsWith(basis));
  const hashed = others.filter((name) => !likely.includes(name) && shortNameBasis(name).startsWith(basis.slice(0, HASHED_SHORT_NAME_KEPT_CHARACTERS)));
  for (const name of [...likely, ...hashed]) {
    if (identityOf(join(folder, name)) === identity) return name;
  }
  return short;
}

/** The parent of a resolved place is resolved (walking up a resolved spelling meets no link). */
export function resolvedParent(path: ResolvedAbsolutePath): ResolvedAbsolutePath {
  return dirname(path) as ResolvedAbsolutePath;
}

/**
 * `names` below a resolved place, spelled WITHOUT measuring them — only for a
 * caller that compares the result by name under `base`
 * ({@link PathLocator.below}): measuring each costs too much where every
 * `stat` crosses 9p (a Windows drive), and a place named this way that is a
 * link is compared as its name, never followed.
 */
export function namedBelow(base: ResolvedAbsolutePath, names: readonly string[]): ResolvedAbsolutePath {
  return join(base, ...names) as ResolvedAbsolutePath;
}

/** THE ONE `dev:ino` spelling of an identity (bigint, so no inode loses precision). */
export function identityKey(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function identityOf(path: string): string | undefined {
  try {
    return identityKey(statSync(path, { bigint: true }));
  } catch {
    return undefined;
  }
}

/** Segment-wise ancestry of two resolved spellings — the fallback when nothing of either could be measured. */
function spelledAtOrUnder(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return candidate.startsWith(prefix);
}

/** `candidate` lies at or under an entry of `pattern`'s folder whose name starts with `pattern`'s last name. */
function spelledUnderPrefix(candidate: string, pattern: string): boolean {
  const folder = dirname(pattern);
  if (!spelledAtOrUnder(candidate, folder) || candidate === folder) return false;
  const first = candidate.slice(folder === "/" ? 1 : folder.length + 1).split("/")[0] ?? "";
  return first.startsWith(pattern.slice(folder === "/" ? 1 : folder.length + 1));
}

/** Where a path is: its measured chain and the names below the deepest existing part. */
export type LocatedPath = Readonly<{
  /** The resolved spelling (only used when nothing could be measured). */
  path: ResolvedAbsolutePath;
  /** Identities of the deepest existing ancestor-or-self, then each ancestor up to `/`. */
  chain: readonly string[];
  /** The segments below that anchor that do not exist. */
  tail: readonly string[];
  /** The anchor lies on a filesystem whose names compare case-insensitively (a Windows drive). */
  caseless: boolean;
  /**
   * The last name is a PREFIX: the place stands for every entry of its folder
   * whose name starts with it (a database's family — `web.db`, `web.db-wal`,
   * `web.db.pre-v20`… — named once, whatever exists right now). Only a place
   * named with {@link PathLocator.below} is one.
   */
  lastNameIsPrefix: boolean;
}>;

export type PathLocator = Readonly<{
  /** Measure one place now (never cached: a caller that keeps an answer decides for how long). */
  locate: (path: ResolvedAbsolutePath) => LocatedPath;
  /**
   * The place `names` below an already measured `base`, WITHOUT measuring it:
   * compared by `base`'s identity and the names, so it stays right when the
   * place is created later (used where measuring each place costs too much —
   * a Windows drive answers every `stat` over 9p).
   */
  below: (base: LocatedPath, names: readonly string[], lastNameIsPrefix?: boolean) => LocatedPath;
  /** `candidate` IS `ancestor` or lies under it — by identity. */
  atOrUnder: (candidate: LocatedPath, ancestor: LocatedPath) => boolean;
  /** The names of `candidate` below `ancestor` (by identity; `[]` when it IS it), or undefined when it is not at or under it. */
  namesUnder: (candidate: LocatedPath, ancestor: LocatedPath) => readonly string[] | undefined;
}>;

/**
 * A locator over this process's Windows drives (`windowsDriveMountPoints`,
 * read once per process: which mounts compare names case-insensitively).
 */
export function createPathLocator(): PathLocator {
  const onCaselessMount = onWindowsDrive;
  const locate = (path: ResolvedAbsolutePath): LocatedPath => {
    const tail: string[] = [];
    let anchor: string = path;
    let identity = identityOf(anchor);
    while (identity === undefined) {
      const parent = dirname(anchor);
      if (parent === anchor) break;
      tail.unshift(anchor.slice(parent === "/" ? 1 : parent.length + 1));
      anchor = parent;
      identity = identityOf(anchor);
    }
    const chain: string[] = identity === undefined ? [] : [identity];
    for (let current = anchor, parent = dirname(current); parent !== current; current = parent, parent = dirname(current)) {
      const parentIdentity = identityOf(parent);
      if (parentIdentity !== undefined) chain.push(parentIdentity);
    }
    return Object.freeze({ path, chain, tail, caseless: onCaselessMount(anchor), lastNameIsPrefix: false });
  };
  const below = (base: LocatedPath, names: readonly string[], lastNameIsPrefix = false): LocatedPath => Object.freeze({
    path: namedBelow(base.path, names),
    chain: base.chain,
    tail: [...base.tail, ...names],
    caseless: base.caseless,
    lastNameIsPrefix: lastNameIsPrefix && names.length > 0,
  });
  const fold = (name: string, caseless: boolean): string => (caseless ? name.toLowerCase() : name);
  const sameName = (a: string, b: string | undefined, caseless: boolean, prefix: boolean): boolean =>
    b !== undefined && (prefix ? fold(b, caseless).startsWith(fold(a, caseless)) : fold(a, caseless) === fold(b, caseless));
  /**
   * The names of `c` below the existing place `identity` is (on `c`'s own
   * measured chain), or undefined when `c` is not under it. `c.path` is a
   * resolved spelling, so its last names ARE the names below each ancestor
   * the chain measured.
   */
  const namesBelow = (c: LocatedPath, identity: string): readonly string[] | undefined => {
    const depth = c.chain.indexOf(identity);
    if (depth < 0) return undefined;
    const segments = c.path.split("/").filter((segment) => segment.length > 0);
    return segments.slice(segments.length - (depth + c.tail.length));
  };
  /** `prefix` (an ancestor's names) starts `names`; with `lastIsPrefix`, its last name only has to start the matching name. */
  const isPrefix = (prefix: readonly string[], names: readonly string[] | undefined, caseless: boolean, lastIsPrefix: boolean): boolean =>
    names !== undefined && names.length >= prefix.length
    && prefix.every((segment, index) => sameName(segment, names[index], caseless, lastIsPrefix && index === prefix.length - 1));
  /**
   * A located place is its measured anchor plus the names below it; `c` is at
   * or under `a` when `a`'s place is a prefix of `c`'s. Whichever anchor lies
   * deeper is read from the other's chain, and the names between them from
   * the deeper one's own resolved spelling — so a place that did not exist
   * when it was measured (or was only named, {@link PathLocator.below}) is
   * still recognised when it is created later.
   */
  const atOrUnder = (c: LocatedPath, a: LocatedPath): boolean => {
    const anchor = a.chain[0];
    const candidateAnchor = c.chain[0];
    // Nothing of either path could be measured: the spelling is the only fact left.
    if (anchor === undefined || candidateAnchor === undefined) return a.lastNameIsPrefix ? spelledUnderPrefix(c.path, a.path) : spelledAtOrUnder(c.path, a.path);
    const caseless = a.caseless || c.caseless;
    // `a`'s anchor is on `c`'s chain: `a`'s names must start `c`'s names below it.
    if (c.chain.includes(anchor)) return isPrefix(a.tail, namesBelow(c, anchor), caseless, a.lastNameIsPrefix);
    // `c`'s anchor is on `a`'s chain (a place only named below it): `c`'s names
    // must continue past everything between its anchor and `a`.
    if (a.chain.includes(candidateAnchor)) return isPrefix(namesBelow(a, candidateAnchor) ?? [], c.tail, caseless, a.lastNameIsPrefix);
    return false;
  };
  const namesUnder = (c: LocatedPath, a: LocatedPath): readonly string[] | undefined => {
    if (!atOrUnder(c, a)) return undefined;
    const anchor = a.chain[0];
    if (anchor !== undefined && c.chain.includes(anchor)) return (namesBelow(c, anchor) ?? []).slice(a.tail.length);
    // `c`'s anchor lies between `a`'s anchor and `a` (a place only named): its names past `a`'s.
    const candidateAnchor = c.chain[0];
    if (candidateAnchor !== undefined) return c.tail.slice((namesBelow(a, candidateAnchor) ?? []).length);
    return c.path.split("/").filter((segment) => segment.length > 0).slice(a.path.split("/").filter((segment) => segment.length > 0).length);
  };
  return Object.freeze({ locate, below, atOrUnder, namesUnder });
}

export type IdentityOverlapIndex = Readonly<{
  /** `candidate` IS `ancestor` or lies under it — by identity. */
  atOrUnder: (candidate: ResolvedAbsolutePath, ancestor: ResolvedAbsolutePath) => boolean;
  /** Either is an ancestor-or-self of the other — by identity. */
  overlaps: (a: ResolvedAbsolutePath, b: ResolvedAbsolutePath) => boolean;
}>;

/**
 * One locator per decision (a compile, a request): each path's chain is
 * measured once and memoised for the index's life, so a spec's rules × kept-out
 * places cost one `stat` per ancestor.
 */
export function identityOverlapIndex(): IdentityOverlapIndex {
  const locator = createPathLocator();
  const located = new Map<string, LocatedPath>();
  const locate = (path: ResolvedAbsolutePath): LocatedPath => {
    let entry = located.get(path);
    if (entry === undefined) {
      entry = locator.locate(path);
      located.set(path, entry);
    }
    return entry;
  };
  const atOrUnder = (candidate: ResolvedAbsolutePath, ancestor: ResolvedAbsolutePath): boolean =>
    locator.atOrUnder(locate(candidate), locate(ancestor));
  return Object.freeze({
    atOrUnder,
    overlaps: (a: ResolvedAbsolutePath, b: ResolvedAbsolutePath): boolean => atOrUnder(a, b) || atOrUnder(b, a),
  });
}

/**
 * A region a path may be required to stay inside: the spelling a caller was
 * handed, and the place it really is. Both are needed — see
 * {@link assertResolvesWithinRegion}.
 */
export type PathRegion = Readonly<{
  /** The spelling. May itself be a link; that is allowed and is not the bug. */
  raw: string;
  /** Where that spelling really points, after every link is followed. */
  resolved: ResolvedAbsolutePath;
}>;

/**
 * A PATH THAT NAMES A PLACE INSIDE `region` MUST STILL BE INSIDE IT AFTER
 * EVERY LINK IS FOLLOWED.
 *
 * A rule for `<project>/.bridlewise/scratch` used to compile to whatever that
 * name resolved to, and the project is writable from inside the sandbox:
 * measured end to end, a confined command created that one link pointing at
 * `~/.ssh` and the NEXT confined command listed the private keys. "Named
 * inside the region" has two honest readings (the region's root may itself be
 * a link), so either spelling counts — the superset, which only brings MORE
 * paths under the obligation. A path that never claimed to be inside the
 * region (`/usr`, the interpreter's prefix) is not this function's business.
 */
export function assertResolvesWithinRegion(
  raw: string,
  resolved: ResolvedAbsolutePath,
  region: PathRegion,
  what: string,
  regionName: string,
): void {
  if (staysWithinRegion(raw, resolved, region)) return;
  throw new InputError(
    `${what} names a place inside ${regionName} but resolves outside it: ${JSON.stringify(raw)} → ${resolved}, which is not under ${region.resolved}. `
    + "A path inside a directory that anything untrusted can write to must not be able to point out of it — otherwise a single symbolic link turns a rule about that directory into a rule about somewhere else.",
    "path_escapes_region",
  );
}

/**
 * The QUESTION behind {@link assertResolvesWithinRegion}, without the refusal:
 * the compiler REFUSES an operator path that escapes, the server DROPS a rule
 * it derived itself (refusing would let one link stop every command in a
 * project). The first half asks what the raw string SPELLS (that is the
 * question, so it is a spelling); where it really is, is asked by identity.
 */
export function staysWithinRegion(
  raw: string,
  resolved: ResolvedAbsolutePath,
  region: PathRegion,
): boolean {
  if (!namesPlaceUnder(raw, region)) return true;
  const locator = createPathLocator();
  return locator.atOrUnder(locator.locate(resolved), locator.locate(region.resolved));
}

/**
 * Does `raw` SPELL a place at or under `region`, before any link is followed?
 * Unexported, so the lexical question is never asked on a raw string anywhere
 * else. `resolve()` collapses `.`, `..`, repeated and trailing separators —
 * exactly the normalisation needed to compare two spellings.
 */
function namesPlaceUnder(raw: string, region: PathRegion): boolean {
  if (!isAbsolute(raw)) return false;
  const lexical = resolve(raw);
  return [resolve(region.raw), region.resolved as string].some((container) => spelledAtOrUnder(lexical, container));
}

/**
 * A FOLDER HELD BY ITS DESCRIPTOR, reached from `root` one name at a time,
 * NEVER THROUGH A LINK. `path` names it through the descriptor
 * (`/proc/self/fd/<fd>`), so a name joined to it is opened, listed or
 * written in THAT folder even if someone swaps a parent for a link after the
 * walk: the check and the use are the same object. Close it when done.
 */
export type ContainedFolder = Readonly<{ path: string; close: () => void }>;

/**
 * Open the folder `segments` names below `root` without following a link at
 * any step (each step opens its child relative to the folder held so far,
 * `O_NOFOLLOW`): a link is `path_through_link`, anything else that is not a
 * folder `path_not_a_folder`. With `create`, a missing folder is made ONE
 * LEVEL AT A TIME (an ordinary folder: the umask decides its mode) and opened
 * the same way; without it, a missing one is `undefined`. The folder reached
 * is then confirmed at or under `root` BY IDENTITY (a bind mount inside the
 * root is not a way out): `path_outside_root`. Linux only, like every
 * descriptor-pinned owner here.
 */
export function openContainedFolder(root: ResolvedAbsolutePath, segments: readonly string[], create: boolean): ContainedFolder | undefined {
  const procRoot = ROOT_POLICY.receipts.immutableExecution.procFileDescriptorRoot;
  const viaDescriptor = (fd: number): string => join(procRoot, String(fd));
  let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let spelled: string = root;
  try {
    for (const segment of segments) {
      if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("/")) {
        throw new InputError(`${JSON.stringify(segment)} is not one folder name below ${spelled}`, "path_segment_invalid");
      }
      const child = join(viaDescriptor(fd), segment);
      spelled = join(spelled, segment);
      let next: number;
      try {
        next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          if (!create) {
            closeSync(fd);
            return undefined;
          }
          try {
            mkdirSync(child);
          } catch (made) {
            if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw made;
          }
          next = openContainedChild(child, spelled);
        } else {
          throw containedRefusal(code, child, spelled, error);
        }
      }
      closeSync(fd);
      fd = next;
    }
    const reached = resolveLocation(readlinkSync(viaDescriptor(fd)), "a contained folder");
    if (!identityOverlapIndex().atOrUnder(reached, root)) {
      throw new SecurityError(`${spelled} resolves to ${reached}, outside ${root}`, "path_outside_root");
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const held = fd;
  return Object.freeze({ path: viaDescriptor(held), close: () => closeSync(held) });
}

/** Open a folder just created (or raced into existence) under a held parent, refusing a link exactly as the walk does. */
function openContainedChild(child: string, spelled: string): number {
  try {
    return openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw containedRefusal((error as NodeJS.ErrnoException).code, child, spelled, error);
  }
}

/** The typed refusal for a step of the contained walk that met a link (`ELOOP`) or a non-folder (`ENOTDIR`); any other fault is the fault. */
function containedRefusal(code: string | undefined, child: string, spelled: string, error: unknown): unknown {
  if (code === "ELOOP") return new SecurityError(`${spelled} is a link; nothing is read or written through one`, "path_through_link");
  if (code === "ENOTDIR") {
    const stat = lstatSync(child, { throwIfNoEntry: false });
    return stat?.isSymbolicLink() === true
      ? new SecurityError(`${spelled} is a link; nothing is read or written through one`, "path_through_link")
      : new SecurityError(`${spelled} is not a folder`, "path_not_a_folder");
  }
  return error;
}
