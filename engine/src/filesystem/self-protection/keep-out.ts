/**
 * THE ONE KEEP-OUT LIST — every place no confined process may be granted and
 * no project folder or project file may reach: the harness's own protected
 * code, the credential/key/browser/history stores of every home the host has,
 * the key home and every harness store registered there, the evidence store
 * (wherever its private-home setting puts it), the host's own
 * files, and the operator's additions. One concept (it used to be two:
 * "protected subtrees" and "refused paths", with identical meaning, two
 * operator keys, and only one of them reaching the C guardian).
 *
 * Consumers, one verdict each:
 *   - the guardian spec compiler (`guardian-binary.ts`): no allow-rule or temp
 *     folder may equal, contain or sit inside an entry, and every entry that
 *     exists is EMITTED into the spec, so the C guardian refuses it
 *     physically, by identity, from the descriptor it checked;
 *   - the web server's project door, folder picker and file choke point.
 *
 * Every comparison is by identity (`path-identity.ts`). An entry is measured
 * as its BASE folder (a home, or the entry's parent) plus the names below it,
 * so an entry created, deleted or re-created after the list was measured
 * (`~/.aws` appearing, a `-wal` file coming and going) is still recognised by
 * name under a base whose identity holds — case-insensitively on a Windows
 * drive, where `.CODEX` is `.codex` (and `CODEX~1`: a resolved spelling never
 * carries a short name). A store's whole family is one PREFIX entry
 * (`web.db*`, `db-key*` in its folder), so a copy written after the list was
 * built is a member at once.
 *
 * Two arms need no list at all:
 *   - an install still keeping its key beside its database
 *     (`database-files.ts` `legacyInstallIn`) is refused by shape, registered
 *     or not — any place inside such a folder, and (for a grant or a project)
 *     a folder that contains one within `legacyInstalls.containedSearchDepth`;
 *   - a store name the floor lists (`.ssh`, `.codex`…) directly inside a
 *     HOME-LIKE folder no home of this host measured (another account's, a
 *     copied one): `/home/<u>/.ssh`, `/srv/backup/home/<u>/.ssh`. The same
 *     name inside a project is project content (its secret values are
 *     redacted by `privacy/secret-files.ts` at the FILE door; a confined
 *     command reads them raw — the stated residual in this folder's README).
 *
 * The list is REBUILT only when something it is built from changed (its
 * generation: the registry's records, the config, the host's facts, the
 * environment's home, the wildcard folders' listings); each place asked
 * about is measured fresh.
 */

import { lstatSync, readdirSync, readlinkSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { sha256 } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { databaseFamily, legacyInstallIn, UNLISTABLE_DIRECTORY_CODES } from "../database-files.ts";
import { windowsDriveMountPoints } from "../linux-path.ts";
import { createPathLocator, namedBelow, resolvedParent, resolveLocation, type LocatedPath, type PathLocator, type ResolvedAbsolutePath } from "../path-identity.ts";
import { EVIDENCE_HOME, privateHomeSetting } from "../private-home.ts";
import { HOME_PREFIX, underUserHome } from "../user-folders.ts";
import { auditEvent } from "../../shared/debug/debug-system.ts";
import { hasErrorCode, SecurityError } from "../../kernel/errors.ts";

import type { HarnessStoreRegistry } from "./key-home.ts";
import type { SelfProtectionConfig } from "./self-protection-config.ts";

/** Where an entry comes from, in the order a place meeting several is answered (the harness's own code first). */
const SOURCE_ORDER = ["harness", "key-home", "store", "host", "home", "operator"] as const;
export type KeepOutSource = typeof SOURCE_ORDER[number];

export type KeepOutEntry = Readonly<{
  /** The place, spelled resolved (for messages, the spec and a spelling fallback); a prefix entry ends in its prefix. */
  path: ResolvedAbsolutePath;
  /**
   * The place as it is NAMED, every link on the way kept (`~/.ssh` when it is
   * a link chain, the operator's spelling): what the guardian is handed and
   * what {@link keepOutLinkPlaces} judges, so a link chain through a grant is
   * judged hop by hop for EVERY entry, never only the floor's (security MF-2).
   * A prefix entry is spelled as its folder is NAMED plus its prefix, so its
   * members are named through the same links (a registered store's family,
   * the floor's own folder: MF-C).
   */
  spelled: string;
  /**
   * The link resolves to a place that stores nothing (a device, a FIFO): the
   * entry is judged only by what decides its link (its hops, and its target's
   * folder for a grant that can make or remove entries there), never by the
   * resolved place itself, so `-> /dev/null` never makes `/dev` ungrantable.
   */
  inert?: true;
  source: KeepOutSource;
  /** The folder it is measured from, and the names below it. */
  base: ResolvedAbsolutePath;
  names: readonly string[];
  /** The last name is a PREFIX: every entry of that folder whose name starts with it. */
  prefix: boolean;
  /** For a prefix entry: first names below the base that it does NOT cover (the harness's own installation). */
  except: readonly string[];
  /** On a Windows drive: compared by the compiler and the doors, never emitted (see {@link emittedKeepOut}). */
  windowsDrive: boolean;
}>;

/**
 * What only the host knows: the harness checkout the floor's relative entries
 * hang from, more of the harness's own code, its own databases (their whole
 * families) and other files (its config document…), and the registry of the
 * key home it admitted — an explicit dependency, never a global read.
 */
export type KeepOutFacts = Readonly<{
  harnessRoot: string;
  /** More of the harness's own code the host knows about (the web server's folders), kept out like the floor's. */
  harnessPaths?: readonly string[];
  /** The host's own databases: each one's whole family is kept out. */
  hostStores?: readonly string[];
  hostPaths: readonly string[];
  /** The key home's registry: the key home itself and every registered store. */
  registry: HarnessStoreRegistry;
}>;

/** A home-relative entry: `~/` + names; a trailing `*` on the last name is a prefix over that folder's entries. */
const PREFIX_WILDCARD = "*";

export type HostHome = Readonly<{ path: ResolvedAbsolutePath; windowsDrive: boolean }>;

let windowsProfilesCache: readonly HostHome[] | undefined;

/**
 * EVERY HOME THE HOST HAS: this user's (as the environment names it now), and
 * on WSL every Windows profile (`<drive>/Users/<name>`) of every mounted
 * Windows drive, shared profiles excepted — listed once per process (a new
 * Windows profile appears with a new Windows account; the next start sees it).
 */
export function hostHomes(): readonly HostHome[] {
  return [{ path: resolveLocation(homedir(), "the home folder"), windowsDrive: false }, ...windowsProfiles()];
}

/** Every mounted Windows drive (DrvFs), resolved. */
function windowsDrives(): readonly ResolvedAbsolutePath[] {
  return windowsDriveMountPoints().flatMap((drive) => {
    try { return [resolveLocation(drive, "a Windows drive")]; } catch { return []; }
  });
}

function windowsProfiles(): readonly HostHome[] {
  if (windowsProfilesCache !== undefined) return windowsProfilesCache;
  const profiles: HostHome[] = [];
  const policy = ROOT_POLICY.selfProtection.windowsProfiles;
  for (const drive of windowsDrives()) {
    let entries: readonly Dirent[] = [];
    try { entries = readdirSync(join(drive, policy.usersDirectory), { withFileTypes: true }); } catch (error) {
      // A drive with no profiles folder, or one this user cannot list (so no
      // process of this user — a confined child included — can read under it).
      if (!hasErrorCode(error, ...UNLISTABLE_DIRECTORY_CODES)) throw error;
      continue;
    }
    const users = resolveLocation(join(drive, policy.usersDirectory), "a Windows drive's profiles");
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (policy.sharedProfiles.some((shared) => shared.toLowerCase() === entry.name.toLowerCase())) continue;
      profiles.push({ path: namedBelow(users, [entry.name]), windowsDrive: true });
    }
  }
  windowsProfilesCache = Object.freeze(profiles);
  return windowsProfilesCache;
}

/** The names of one home-relative entry: `~/.ssh` → `[".ssh"]`; a trailing `*` is kept as the prefix (without it). */
function homeEntryNames(entry: string): Readonly<{ names: readonly string[]; prefix: boolean }> {
  const names = entry.slice(HOME_PREFIX.length).split("/");
  const last = names.at(-1) ?? "";
  if (!last.endsWith(PREFIX_WILDCARD)) return { names, prefix: false };
  return { names: [...names.slice(0, -1), last.slice(0, -PREFIX_WILDCARD.length)], prefix: true };
}

/** A place a link took somewhere that is not a file or folder (`~/.mysql_history -> /dev/null`): nothing is stored there. */
function isDeviceOrPipe(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat !== undefined && !stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink();
}

/** The names of `place` below `base`, by identity, or undefined when it is not at or under it. */
function namesBelowBase(locator: PathLocator, place: ResolvedAbsolutePath, base: ResolvedAbsolutePath): readonly string[] | undefined {
  return locator.namesUnder(locator.locate(place), locator.locate(base));
}

/**
 * THE LIST IN FORCE for this host, config and facts. The operator's entries
 * are absolute or `~/` (this user's home). A `*` entry never covers the
 * harness's own installation — the folder below its base that holds the
 * harness root OR any of the host's harness code (a checkout under
 * `~/.local/state/<product>-*` is protected by the harness floor, not refused
 * wholesale).
 */
export function keepOutInForce(config: SelfProtectionConfig, facts: KeepOutFacts): readonly KeepOutEntry[] {
  return collectKeepOut(facts.harnessRoot, facts.harnessPaths ?? [], { config, facts });
}

/**
 * THE FLOOR ALONE: the harness's protected subtrees and code, every home's
 * credential stores and wildcards, the machine-wide Windows stores — what
 * holds on every host whatever its key home, stores or operator say. What a
 * process that has no host facts yet (a test runner judging its temp root,
 * TMPDIR-KEEPOUT-001) can ask: whether `place` is, is inside, or holds an
 * entry of the floor for the harness checkout at `harnessRoot`.
 */
export function floorKeepOutVerdict(harnessRoot: string, place: string): KeepOutVerdict | undefined {
  return keepOutPolicy(collectKeepOut(harnessRoot, [], undefined)).verdict(place);
}

/** The entries of the floor for `harnessRoot`, plus the host's (`host`: its config and facts) when given; sorted. */
function collectKeepOut(harnessRoot: string, harnessPaths: readonly string[], host: Readonly<{ config: SelfProtectionConfig; facts: KeepOutFacts }> | undefined): readonly KeepOutEntry[] {
  const floor = ROOT_POLICY.selfProtection;
  const entries = new Map<string, KeepOutEntry>();
  const put = (entry: Omit<KeepOutEntry, "prefix" | "except" | "spelled"> & Partial<Pick<KeepOutEntry, "prefix" | "except" | "spelled">>): void => {
    if (!entries.has(entry.path)) entries.set(entry.path, Object.freeze({ prefix: false, except: [], spelled: entry.path, ...entry }));
  };
  // A place measured from its own parent: a file that comes and goes keeps its name; its spelling keeps its links.
  const addPlace = (raw: string, source: KeepOutSource, what: string): void => {
    const path = resolveLocation(raw, what);
    put({ path, spelled: isAbsolute(raw) ? raw : resolve(raw), source, base: resolvedParent(path), names: [basename(path)], windowsDrive: false });
  };
  // A database's whole family, by prefix under its folder.
  const addStore = (store: string, source: KeepOutSource): void => {
    const family = databaseFamily(store);
    if (family === undefined) return;
    const folder = resolveLocation(family.folder, "a harness store's folder");
    // Measured from the resolved folder; NAMED as the store is (its links kept, judged hop by hop: MF-C).
    const spelledFolder = isAbsolute(family.folder) ? family.folder : resolve(family.folder);
    for (const prefix of family.prefixes) put({ path: namedBelow(folder, [prefix]), spelled: join(spelledFolder, prefix), source, base: folder, names: [prefix], prefix: true, windowsDrive: false });
  };
  for (const relative of floor.minimumProtectedSubtrees) addPlace(join(harnessRoot, relative), "harness", "protected subtree");
  for (const path of harnessPaths) addPlace(path, "harness", "the host's harness code");
  const locator = createPathLocator();
  // The harness's own code wherever the host says it is: a `*` entry does not
  // cover the folder below its base that holds any of it.
  const harnessCode = [harnessRoot, ...harnessPaths].map((path) => resolveLocation(path, "the harness's code"));
  for (const home of hostHomes()) {
    for (const entry of floor.minimumRefusedPaths) {
      const { names, prefix } = homeEntryNames(entry);
      if (home.windowsDrive) {
        // Nothing measured per entry: every `stat` on a Windows drive crosses 9p.
        if (!prefix) put({ path: namedBelow(home.path, names), source: "home", base: home.path, names, windowsDrive: true });
        continue;
      }
      if (prefix) {
        const base = resolveLocation(join(home.path, ...names.slice(0, -1)), "the safety floor's keep-out list");
        // The first name below the base of each harness code folder there (its top-level entry), and the entry's own last name.
        const except = harnessCode.flatMap((code) => { const top = namesBelowBase(locator, code, base)?.at(0); return top === undefined ? [] : [top]; });
        const last = names.at(-1);
        const lastNames = last === undefined ? [] : [last];
        // NAMED as the home spells it, so a floor folder that is itself a link chain is judged hop by hop (MF-C).
        put({ path: namedBelow(base, lastNames), spelled: join(home.path, ...names), source: "home", base, names: lastNames, prefix: true, except, windowsDrive: false });
        continue;
      }
      const lexical = namedBelow(home.path, names);
      const path = resolveLocation(lexical, "the safety floor's keep-out list");
      if (isDeviceOrPipe(path)) {
        // `ln -s /dev/null ~/.mysql_history` (the MySQL manual's own advice):
        // no history is kept there, and refusing `/dev` would stop every
        // spawn. The entry is judged by its LINK only (its hops, and its
        // target's folder for a grant that can make or remove entries there):
        // a link to a FIFO inside a granted project is still refused (MF-B).
        put({ path: namedBelow(home.path, names), spelled: lexical, source: "home", base: home.path, names, windowsDrive: false, inert: true });
        continue;
      }
      // Measured from the home unless a link took it elsewhere; NAMED as the home spells it (its links kept: MF-2).
      const below = namesBelowBase(locator, path, home.path);
      put(below !== undefined && below.length > 0
        ? { path, spelled: lexical, source: "home", base: home.path, names: below, windowsDrive: false }
        : { path, spelled: lexical, source: "home", base: resolvedParent(path), names: [basename(path)], windowsDrive: false });
    }
  }
  // Machine-wide Windows stores (not in any profile), on every Windows drive.
  for (const drive of windowsDrives()) {
    for (const store of floor.windowsProfiles.machineStores) {
      const names = store.split("/");
      put({ path: namedBelow(drive, names), source: "home", base: drive, names, windowsDrive: true });
    }
  }
  // The evidence store protects ITS OWN place, wherever the operator put it
  // (its default sits outside the `~/.local/state/<product>-*` wildcard): the
  // one private-home owner says where, the same answer the store itself uses.
  addPlace(privateHomeSetting(EVIDENCE_HOME).location, "store", "the evidence store");
  if (host !== undefined) {
    const { config, facts } = host;
    addPlace(facts.registry.keyHome, "key-home", "the key home");
    for (const record of facts.registry.records()) addStore(record.path, "store");
    for (const store of facts.hostStores ?? []) addStore(store, "host");
    for (const path of facts.hostPaths) addPlace(path, "host", "the host's keep-out paths");
    for (const path of config.additionalProtectedSubtrees ?? []) {
      addPlace(underUserHome(path), "operator", "selfProtection.additionalProtectedSubtrees[]");
    }
  }
  // The harness's own code first: a place meeting it is answered in that
  // vocabulary ("this is the harness") before any other entry it also meets.
  return Object.freeze([...entries.values()].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.path.localeCompare(b.path)));
}

/** The most links one resolution follows (the guardian's MAX_LINK_HOPS, the kernel's own bound). */
const MAX_LINK_HOPS = 40;

/**
 * How an entry reached through links resolves: each place that DECIDES what it
 * names — the (link-free) folder of every link on the way, and of every folder
 * a `..` leaves (whoever can write that folder can replace the folder with a
 * link, and the kernel's `..` then follows it: security MF-1) — and the target
 * or a dangling link's would-be target's deepest existing folder.
 */
export type KeepOutLinkPlaces = Readonly<{
  hops: readonly Readonly<{ link: string; folder: string }>[];
  /** The final target; for a dangling link, the deepest existing folder of its would-be target; null when none is reached (a loop, or a folder on the way this user cannot search). */
  target: string | null;
  dangling: boolean;
  looping: boolean;
  /** A folder on the way cannot be searched (EACCES): see {@link blocked}. */
  unsearchable: boolean;
  /**
   * The folder whose permission bits stopped the walk. One this user OWNS is
   * refused, never trusted: Landlock does not mediate `chmod`, so a confined
   * process could have made it unsearchable to hide what lies behind it
   * (security MF-B). One another user owns is no folder a confined process
   * can change: the places met are judged and the entry is kept by its name.
   */
  blocked: string | null;
  /** The target is neither a file nor a folder (a device, a FIFO, a socket): it stores nothing a grant could reach (MF-3). */
  inert: boolean;
}>;

/**
 * THE ONE DEFINITION OF HOW A KEEP-OUT ENTRY RESOLVES (GUARD-F5, the security
 * re-verification's link findings) — the guardian's `resolve_entry`
 * (engine/guardian/landlock-guardian.c), line for line: one component at a
 * time (`lstat`, `readlink`), at most {@link MAX_LINK_HOPS} links. Whoever can
 * write a hop's folder can retarget the link, and whoever can write the
 * target — or a dangling link's would-be target's deepest existing folder —
 * owns what the entry names. ONE judgement on both sides: the guardian refuses
 * a SPAWN whose grant holds one of them or lies at or under an existing
 * target, and the project door refuses a PROJECT the same way. A target that
 * is neither a file nor a folder (`-> /dev/null`, a FIFO) stores nothing, and
 * a folder this user cannot search ends the walk: either way the places
 * already met are judged and the entry is kept by its name — never a refusal
 * of every spawn (MF-3).
 * `undefined` when nothing on the way decides (no link, no `..`).
 */
export function keepOutLinkPlaces(path: string): KeepOutLinkPlaces | undefined {
  const hops: { link: string; folder: string }[] = [];
  let links = 0;
  let current = "";
  let rest = path.split("/");
  let inert = false;
  const parentOf = (folder: string): string => folder.slice(0, Math.max(0, folder.lastIndexOf("/")));
  const places = (target: string | null, flags: Readonly<{ dangling?: boolean; looping?: boolean; blocked?: string }>): KeepOutLinkPlaces | undefined =>
    hops.length === 0 ? undefined : Object.freeze({ hops: Object.freeze(hops), target, dangling: flags.dangling ?? false, looping: flags.looping ?? false, unsearchable: flags.blocked !== undefined, blocked: flags.blocked ?? null, inert });
  for (;;) {
    const component = rest.shift();
    if (component === undefined) break;
    if (component === "" || component === ".") continue;
    if (component === "..") {
      // The folder this `..` leaves decides where it lands: whoever can write ITS folder can make it a link (MF-1).
      if (current !== "") hops.push({ link: current, folder: parentOf(current) === "" ? "/" : parentOf(current) });
      current = parentOf(current);
      continue;
    }
    const candidate = `${current}/${component}`;
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (hasErrorCode(error, "EACCES")) return places(null, { blocked: current === "" ? "/" : current });
      if (!hasErrorCode(error, "ENOENT", "ENOTDIR")) throw error;
      return places(current === "" ? "/" : current, { dangling: true });
    }
    if (!stat.isSymbolicLink()) {
      current = candidate;
      inert = !stat.isFile() && !stat.isDirectory();
      continue;
    }
    if (links === MAX_LINK_HOPS) return places(null, { looping: true });
    links += 1;
    const text = readlinkSync(candidate);
    hops.push({ link: candidate, folder: current === "" ? "/" : current });
    rest = [...text.split("/"), ...rest];
    if (text.startsWith("/")) current = "";
  }
  return places(current === "" ? "/" : current, {});
}

/** Every existing keep-out place an entry stands for now, as it is NAMED (a prefix entry: each member present in its folder, named through its folder's links). */
function presentMembers(entry: KeepOutEntry): readonly string[] {
  if (entry.windowsDrive) return [];
  if (!entry.prefix) return [entry.spelled];
  const folder = dirname(entry.spelled);
  const prefix = entry.names.at(-1) ?? "";
  let names: readonly string[];
  try { names = readdirSync(folder); } catch (error) {
    if (!hasErrorCode(error, ...UNLISTABLE_DIRECTORY_CODES)) throw error;
    // A floor folder this user cannot list: refused when its permission bits are this user's to change (MF-B).
    if (hasErrorCode(error, "EACCES", "EPERM")) refuseOwnUnsearchable(folder, entry.spelled, "cannot be listed, because of");
    return [];
  }
  return names.filter((name) => name.startsWith(prefix) && !entry.except.includes(name)).map((name) => join(folder, name));
}

/**
 * MF-B: THE KEEP-OUT JUDGEMENT NEVER DEPENDS ON PERMISSION BITS A CONFINED
 * PROCESS CAN CHANGE. `path`'s nearest folder that can be examined is the one
 * whose permissions stopped a walk or a listing; when THIS user owns it, a
 * confined process (this user, under Landlock, which does not mediate
 * `chmod`) could have closed it to hide what lies behind it, so the whole
 * judgement is refused — named, audited, with its remedy — and fails closed.
 * A folder another user owns is not one a confined process can change.
 */
function refuseOwnUnsearchable(path: string, entry: string, why: string): void {
  for (let folder = path; ; folder = dirname(folder)) {
    let uid: number;
    try { uid = statSync(folder).uid; } catch (error) {
      if (!hasErrorCode(error, "EACCES", "EPERM", "ENOENT", "ENOTDIR")) throw error;
      if (folder === dirname(folder)) return;
      continue;
    }
    if (uid !== process.geteuid?.()) return;
    auditEvent("self-protection.keep-out-folder-unsearchable", { entry, folder });
    throw new SecurityError(
      `keep-out entry ${entry} ${why} '${folder}', a folder this user owns but cannot search: a confined process can change its permission bits, so what lies behind it cannot be judged; every grant is refused until its permissions are restored (chmod u+rwx '${folder}')`,
      "self_protection_keep_out_folder_unsearchable",
    );
  }
}

/** The access flags that can make or remove entries in a folder: a grant holding one can put its own file where an inert target (a FIFO) stands. */
const ENTRY_CHANGING_ACCESS: ReadonlySet<string> = new Set(["MAKE_CHAR", "MAKE_DIR", "MAKE_REG", "MAKE_SOCK", "MAKE_FIFO", "MAKE_BLOCK", "MAKE_SYM", "REMOVE_DIR", "REMOVE_FILE", "REFER"]);

/** What the list says about one place: nothing, or which entry it meets and how. */
export type KeepOutVerdict = Readonly<{
  entry: KeepOutEntry;
  /** `under`: the place is the entry or inside it; `contains`: the place holds the entry. */
  relation: "under" | "contains";
}>;

/** One operation's questions (a search walk, a request, a compile): the answers about folders it meets are remembered for its life only. */
export type KeepOutQuestions = Readonly<{
  /** The place is an entry, inside one, or holds one of the LISTED entries; or lies inside an unregistered install. */
  verdict: (path: string) => KeepOutVerdict | undefined;
  /**
   * The same, for a place about to be GRANTED or opened as a project: it
   * also must not CONTAIN an unregistered install (looked for below it,
   * within the policy's bounded depth), nor — when its `access` can make or
   * remove entries (a project: every access, the default) — the folder of an
   * entry's inert link target (MF-B).
   */
  grantVerdict: (path: string, access?: readonly string[]) => KeepOutVerdict | undefined;
}>;

/**
 * What ONE operation serves: `servedProject`, the project whose files it
 * reads or writes (the file door, a search walk). A home-like folder INSIDE
 * that project (a dotfiles repository's `home/alice/.npmrc`, a test fixture's
 * `home/user/.docker/config.json`) is project content, served with its values
 * hidden by the secret-file owner — never refused by the name arm
 * (sec-e-design M1). Only a project the list itself admits has that
 * privilege: one inside a named store, or an old project AT a home (it holds
 * the home's stores), keeps the arm for everything inside it.
 */
export type KeepOutScope = Readonly<{ servedProject?: string }>;

export type KeepOutPolicy = KeepOutQuestions & Readonly<{
  entries: readonly KeepOutEntry[];
  /** Questions for ONE operation (a walk asks per entry): folder answers are remembered for its life. */
  operation: (scope?: KeepOutScope) => KeepOutQuestions;
}>;

const FILESYSTEM_ROOT = resolveLocation("/", "the filesystem root");

/** The floor's store names (the non-wildcard home entries), for the home-like name arm. */
const STORE_NAMES: readonly (readonly string[])[] = ROOT_POLICY.selfProtection.minimumRefusedPaths
  .filter((entry) => !entry.endsWith(PREFIX_WILDCARD))
  .map((entry) => entry.slice(HOME_PREFIX.length).split("/"));

/**
 * THE HOME-LIKE NAME ARM: a place whose path runs through a store the floor
 * names DIRECTLY INSIDE a home-like folder (`<…>/home/<u>/`, `<…>/Users/<u>/`,
 * `/root/`) lies inside a credential store even where no home of this host
 * could be measured. Case-insensitively on a Windows drive. Only the INSIDE
 * direction: a folder that merely contains one somewhere cannot be known
 * without listing it. `servedContent` answers whether a home-like folder is
 * content of the project the operation serves (then it is not a home).
 */
function homeStoreNamed(resolved: ResolvedAbsolutePath, caseless: boolean, servedContent: (folder: ResolvedAbsolutePath) => boolean): KeepOutVerdict | undefined {
  const policy = ROOT_POLICY.selfProtection;
  const segments = resolved.split("/").filter((segment) => segment.length > 0);
  const fold = (name: string): string => (caseless ? name.toLowerCase() : name);
  const homeStarts: number[] = [];
  for (let index = 2; index <= segments.length; index += 1) {
    if (policy.homeParents.some((parent) => fold(parent) === fold(segments[index - 2] ?? ""))) homeStarts.push(index);
  }
  for (const folder of policy.homeFolders) {
    const home = folder.split("/").filter((segment) => segment.length > 0);
    if (home.every((name, offset) => fold(name) === fold(segments[offset] ?? ""))) homeStarts.push(home.length);
  }
  for (const start of homeStarts) {
    // The home-like folder itself (`<…>/home/<u>`, `/root`) inside the served project: project content.
    if (servedContent(namedBelow(FILESYSTEM_ROOT, segments.slice(0, start)))) continue;
    for (const names of STORE_NAMES) {
      if (start + names.length <= segments.length && names.every((name, offset) => fold(name) === fold(segments[start + offset] ?? ""))) {
        const path = namedBelow(FILESYSTEM_ROOT, segments.slice(0, start + names.length));
        return { entry: Object.freeze({ path, spelled: path, source: "home", base: resolvedParent(path), names: [basename(path)], prefix: false, except: [], windowsDrive: caseless }), relation: "under" };
      }
    }
  }
  return undefined;
}

/** An unregistered install's folder as an entry (its whole family by prefix). */
function legacyEntry(folder: string): KeepOutEntry {
  const path = resolveLocation(folder, "an install keeping its key beside its database");
  return Object.freeze({ path, spelled: path, source: "store", base: resolvedParent(path), names: [basename(path)], prefix: false, except: [], windowsDrive: false });
}

/**
 * One policy per list: each entry's base is measured ONCE; each place asked
 * about is measured fresh (a long-lived policy never remembers a stale answer
 * about a user's files — an operation remembers folder answers for its own
 * life only).
 */
function keepOutPolicy(entries: readonly KeepOutEntry[]): KeepOutPolicy {
  const locator = createPathLocator();
  const bases = new Map<string, LocatedPath>();
  const baseOf = (path: ResolvedAbsolutePath): LocatedPath => {
    let located = bases.get(path);
    if (located === undefined) { located = locator.locate(path); bases.set(path, located); }
    return located;
  };
  // Each entry by name under its base AND, where it is a single existing
  // place off a Windows drive, by its own identity — a bind mount of the
  // entry itself (not of an ancestor) is recognised only by the second.
  const located = entries.map((entry) => ({
    entry,
    at: entry.inert === true ? [] : [locator.below(baseOf(entry.base), entry.names, entry.prefix), ...(entry.windowsDrive || entry.prefix ? [] : [locator.locate(entry.path)])],
    except: entry.except.map((name) => locator.below(baseOf(entry.base), [name])),
  }));
  // Each entry reached through links, by the ONE definition (`keepOutLinkPlaces`): a place at or under a
  // link's target is harness state; a place holding a target, a hop's folder or a dangling link's would-be
  // target's folder could make the entry name its own content.
  const linked = entries.flatMap((entry) => presentMembers(entry).flatMap((member) => {
    const places = keepOutLinkPlaces(member);
    if (places === undefined) return [];
    if (places.blocked !== null) refuseOwnUnsearchable(places.blocked, member, "resolves through");
    if (places.inert || places.unsearchable) {
      // Said, never silent: the entry stays kept by its name, and the places met on the way are judged.
      auditEvent("self-protection.keep-out-target-unjudged", { entry: member, why: places.inert ? "its target stores nothing (not a file or a folder): its folder is judged against grants that can make or remove entries" : "a folder another user owns cannot be searched" });
    }
    const locate = (path: string): LocatedPath => locator.locate(resolveLocation(path, "a place a keep-out link names"));
    // A target that stores nothing (a device, a FIFO) is no place a grant could reach: only the places on the way are judged (MF-3).
    const target = places.target === null || places.dangling || places.inert ? undefined : locate(places.target);
    const held = [...places.hops.map((hop) => locate(hop.folder)), ...(places.dangling && places.target !== null ? [locate(places.target)] : [])];
    // An inert target is replaceable by whoever can make or remove entries in its folder (MF-B).
    const inertFolder = places.inert && places.target !== null ? locate(dirname(places.target)) : undefined;
    return [{ entry, target, held, inertFolder }];
  }));
  const settings = ROOT_POLICY.selfProtection.legacyInstalls;
  const skipped: ReadonlySet<string> = new Set(settings.skippedFolders);
  // The system's own folders (and the floor's grants inside them) hold no
  // user's install and are never walked for one.
  const systemPlaces = [...ROOT_POLICY.selfProtection.systemFolders, ...ROOT_POLICY.selfProtection.minimumAllowSet.map((rule) => rule.path)]
    .map((folder) => locator.locate(resolveLocation(folder, "a system folder")));
  const operation = (scope: KeepOutScope = {}): KeepOutQuestions => {
    const legacyFolders = new Map<string, boolean>();
    const isLegacyFolder = (folder: string): boolean => {
      let answer = legacyFolders.get(folder);
      if (answer === undefined) { answer = legacyInstallIn(folder) !== undefined; legacyFolders.set(folder, answer); }
      return answer;
    };
    /** The unregistered install `resolved` lies in (itself or its nearest such ancestor). */
    const insideLegacy = (resolved: ResolvedAbsolutePath): KeepOutVerdict | undefined => {
      for (let folder: string = resolved, parent = dirname(folder); ; folder = parent, parent = dirname(folder)) {
        if (isLegacyFolder(folder)) return { entry: legacyEntry(folder), relation: "under" };
        if (parent === folder) return undefined;
      }
    };
    /** An unregistered install below `resolved`, breadth first, within the bounded depth and folder count. */
    const holdsLegacy = (resolved: ResolvedAbsolutePath): KeepOutVerdict | undefined => {
      let level: readonly string[] = [resolved];
      let visited = 0;
      for (let depth = 1; depth <= settings.containedSearchDepth && level.length > 0; depth += 1) {
        const next: string[] = [];
        for (const folder of level) {
          let children: readonly Dirent[];
          try { children = readdirSync(folder, { withFileTypes: true }); } catch (error) {
            if (!hasErrorCode(error, ...UNLISTABLE_DIRECTORY_CODES)) throw error;
            continue;
          }
          for (const child of children) {
            if (!child.isDirectory() || skipped.has(child.name)) continue;
            visited += 1;
            if (visited > settings.containedSearchFolders) {
              // The bounded search stops (the residual an unregistered install
              // past the bound shares with one past the depth: registration
              // keeps it out). Audited — the safety floor, recorded with debug
              // off — never silent (sec-e M-4).
              auditEvent("self-protection.legacy-search-budget", { grant: resolved, folders: settings.containedSearchFolders, depth });
              return undefined;
            }
            const below = join(folder, child.name);
            if (isLegacyFolder(below)) return { entry: legacyEntry(below), relation: "contains" };
            next.push(below);
          }
        }
        level = next;
      }
      return undefined;
    };
    const verdictWithin = (path: string, servedContent: (folder: ResolvedAbsolutePath) => boolean, changesEntries = false): KeepOutVerdict | undefined => {
      const resolved = resolveLocation(path, "a place to open");
      const place = locator.locate(resolved);
      for (const { entry, at, except } of located) {
        if (except.some((spot) => locator.atOrUnder(place, spot))) continue;
        if (at.some((spot) => locator.atOrUnder(place, spot))) return { entry, relation: "under" };
        if (at.some((spot) => locator.atOrUnder(spot, place))) return { entry, relation: "contains" };
      }
      for (const { entry, target, held, inertFolder } of linked) {
        if (target !== undefined && locator.atOrUnder(place, target)) return { entry, relation: "under" };
        if ((target !== undefined && locator.atOrUnder(target, place)) || held.some((spot) => locator.atOrUnder(spot, place))) return { entry, relation: "contains" };
        if (changesEntries && inertFolder !== undefined && locator.atOrUnder(inertFolder, place)) return { entry, relation: "contains" };
      }
      return insideLegacy(resolved) ?? homeStoreNamed(resolved, place.caseless, servedContent);
    };
    // THE SERVED PROJECT'S CONTENT is its own only when the list admits the
    // project itself: an old project AT a home (it contains the home's
    // stores) or one inside a store has no such privilege, so a copied home
    // inside it stays refused (secc-design M3). Asked once, on first need.
    let servedProject: LocatedPath | null | undefined;
    const servedContent = (folder: ResolvedAbsolutePath): boolean => {
      if (scope.servedProject === undefined) return false;
      if (servedProject === undefined) {
        servedProject = verdictWithin(scope.servedProject, () => false) === undefined
          ? locator.locate(resolveLocation(scope.servedProject, "the project an operation serves"))
          : null;
      }
      return servedProject !== null && locator.atOrUnder(locator.locate(folder), servedProject);
    };
    const verdict = (path: string): KeepOutVerdict | undefined => verdictWithin(path, servedContent);
    const grantVerdict = (path: string, access?: readonly string[]): KeepOutVerdict | undefined => {
      const listed = verdictWithin(path, servedContent, access === undefined || access.some((flag) => ENTRY_CHANGING_ACCESS.has(flag)));
      if (listed !== undefined) return listed;
      const resolved = resolveLocation(path, "a place to grant");
      const place = locator.locate(resolved);
      return systemPlaces.some((system) => locator.atOrUnder(place, system)) ? undefined : holdsLegacy(resolved);
    };
    return Object.freeze({ verdict, grantVerdict });
  };
  return Object.freeze({
    entries,
    operation,
    verdict: (path: string) => operation().verdict(path),
    grantVerdict: (path: string, access?: readonly string[]) => operation().grantVerdict(path, access),
  });
}

/**
 * The entries emitted into the guardian spec, in two lists:
 *   - `protectedSubtrees`: the HARNESS's own code, always (a declared harness
 *     folder that is missing makes the guardian refuse the spec — the layout
 *     moved, and the sandbox must not shrink quietly);
 *   - `keepOut`: every other entry that exists NOW (a prefix entry: each
 *     member present in its folder). The guardian compares them the same way
 *     but skips one that is gone by the time it opens it (a store deleted
 *     between the compile and the spawn must not refuse every command; there
 *     is nothing left to protect).
 * An entry on a Windows drive is never emitted: Landlock does not govern
 * DrvFs (a grant there is ineffective, measured) and every `stat` crosses 9p;
 * the compiler and the doors still compare it, like a missing one.
 */
export function emittedKeepOut(entries: readonly KeepOutEntry[]): Readonly<{ protectedSubtrees: readonly ResolvedAbsolutePath[]; keepOut: readonly string[] }> {
  const present = (path: string): boolean => {
    try { statSync(path); return true; } catch { return false; }
  };
  const members = (entry: KeepOutEntry): readonly string[] =>
    entry.prefix ? presentMembers(entry) : presentMembers(entry).filter(present);
  return Object.freeze({
    protectedSubtrees: entries.filter((entry) => entry.source === "harness").map((entry) => entry.path),
    keepOut: [...new Set(entries.filter((entry) => entry.source !== "harness").flatMap(members))],
  });
}

let lastPolicy: Readonly<{ generation: string; bases: readonly string[]; baseStates: string; policy: KeepOutPolicy }> | undefined;

/** A folder's listing state (inode, change time) — part of the generation of an entry built from its listing. */
function folderState(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}`;
  } catch {
    return "";
  }
}

/**
 * THE GENERATION of the list for this config and facts: everything it is
 * built from — the registry's records, the config, the facts, this user's
 * home, the folders the wildcard entries list and the Windows profiles —
 * reduced to one token, so the list is rebuilt only when one of them moved.
 */
function generationOf(config: SelfProtectionConfig, facts: KeepOutFacts): string {
  const home = homedir();
  const wildcardFolders = ROOT_POLICY.selfProtection.minimumRefusedPaths
    .filter((entry) => entry.endsWith(PREFIX_WILDCARD))
    .map((entry) => dirname(underUserHome(entry)));
  return sha256(JSON.stringify([
    config.additionalProtectedSubtrees ?? [],
    facts.harnessRoot, facts.harnessPaths ?? [], facts.hostStores ?? [], facts.hostPaths,
    facts.registry.keyHome, facts.registry.generation(), privateHomeSetting(EVIDENCE_HOME).location,
    home, wildcardFolders.map(folderState),
  ]));
}

/** How many times a list was built (the generation moved) — observable, so the cache is testable. */
let builds = 0;
export function keepOutListBuilds(): number {
  return builds;
}

/**
 * The policy for the list in force NOW: the list is rebuilt only when its
 * generation moved (a store registered, the config or facts changed, a
 * wildcard folder's listing changed) or when a folder an entry is measured
 * from changed (deleted and re-created, a link made in it: its identity or
 * listing moved — off Windows drives, where every `stat` crosses 9p); an
 * unchanged list is measured once.
 */
export function keepOutPolicyFor(config: SelfProtectionConfig, facts: KeepOutFacts): KeepOutPolicy {
  const generation = generationOf(config, facts);
  if (lastPolicy?.generation === generation && lastPolicy.baseStates === lastPolicy.bases.map(folderState).join("\n")) return lastPolicy.policy;
  builds += 1;
  const entries = keepOutInForce(config, facts);
  const bases = [...new Set(entries.filter((entry) => !entry.windowsDrive).map((entry) => entry.base))];
  lastPolicy = { generation, bases, baseStates: bases.map(folderState).join("\n"), policy: keepOutPolicy(entries) };
  return lastPolicy.policy;
}
