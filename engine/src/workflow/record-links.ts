/**
 * RECORD LINKS — every Markdown link the repository holds names something
 * that exists: a file or folder of the tree, or a file the evidence store
 * records (src/workflow/evidence-store.ts).
 *
 * A record that cites evidence kept out of git links it as
 * `evidence:<recorded path>` (`ROOT_POLICY.workflow.evidenceStore.linkScheme`):
 * the path is the one the manifest records, so `harness evidence materialize
 * <path>` brings the bytes back and `harness evidence verify` proves them. A
 * relative link into a stored folder does NOT resolve (the bytes are not in
 * the tree; a materialized copy is ignored by git), so the reader is never
 * sent to a path that is not there.
 *
 * {@link deadMarkdownLinks} is the scan of the shrink-only ratchet
 * `dead-markdown-links` (engine/scripts/verification/ratchet-baselines.ts):
 * its baseline is EMPTY — `harness check` refuses every dead link outside the
 * frozen record roots, whose byte-exact imported records keep the links they
 * were written with (and whose content is pinned:
 * {@link syncFrozenRecords}). Other URL
 * schemes (`https:`, `mailto:`) and bare anchors are not paths and are not
 * judged; a root-relative link (`/docs/x.md`) is resolved from the
 * repository's top. The links come from THE ONE MARKDOWN PARSER
 * (`shared/markdown.ts` `extractMarkdown`: titles, angle brackets, reference
 * links and definitions; code is never a link), and one resolution
 * ({@link deadLinkReason}) serves every link guard (the agent briefing's too,
 * tests/prevention/agent-docs-liveness.test.ts). A document under a frozen
 * record root (`ROOT_POLICY.verification.frozenRecordRoots`) is history: its
 * links are not judged, by the root, never one link at a time.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, posix } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { flaggedIndexEntries, ownedFiles, revisionFileText, type FlaggedIndexEntry } from "../git/repository-ownership.ts";
import { extractMarkdown } from "../../../shared/markdown.ts";
import { safePercentDecode } from "../privacy/data-policy.ts";
import { recordedEvidence, recordedUnder } from "./evidence-store.ts";

const LINK_SCHEME = ROOT_POLICY.workflow.evidenceStore.linkScheme;

/** Whether repository path `path` lies under a frozen record root (its links are history, not judged). */
function isFrozenRecord(path: string): boolean {
  return ROOT_POLICY.verification.frozenRecordRoots.some((root) => path.startsWith(root));
}

/**
 * THE FROZEN ROOTS' CONTENT IS PINNED (design M1/NH-A, security MF-8): every
 * file under a frozen record root, by its repository path, with the digest of
 * what it holds (a link: of its text), in ONE manifest
 * (`ROOT_POLICY.verification.frozenRecordManifest`) that `harness check`
 * verifies. The commit and merge hooks run that check over the STAGED tree
 * they certify on EVERY commit, whatever paths it touches (the hook's own
 * index, so a partial commit is judged as committed), and a
 * cherry-pick or rebase meets it at the next check.
 *
 * APPEND-ONLY: `harness sync` ADDS a new frozen
 * file's digest (a visible manifest diff a reviewer judges: a closed round's
 * records entering) and NEVER changes or drops a pinned one. An edit, a type
 * change or a removal of a pinned record stays drift until it is accepted by
 * the one explicit door, `harness frozen accept --reason <why> <path>…`
 * ({@link acceptFrozenRecords}), which re-pins exactly the named paths and
 * records each acceptance with its reason in the manifest. Nothing automatic
 * (validate's sync, the suite's auto-heal) ever accepts one.
 */
const FROZEN_RECORDS_SCHEMA = schemaId("frozen-records", 1);

/**
 * What a check found or a write did: `changed` names the frozen paths that differ from the manifest (added, edited or
 * removed); `altered` the pinned ones among them (edited or removed), which only `harness frozen accept` re-pins.
 */
export type FrozenRecordsReport = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent";
  converged: boolean;
  changed: readonly string[];
  altered: readonly string[];
  /** Pins the manifest changed or dropped against HEAD's with no acceptance recorded for exactly that change (a hand edit). */
  unaccepted?: readonly string[];
  /** Frozen paths git keeps apart from the disk while the disk holds them too (or assume-unchanged): an edit git would not see. */
  hidden?: readonly string[];
}>;

/** One accepted change of a pinned frozen record: what it held, what it holds (null: absent), why, and when. */
const FROZEN_ACCEPTANCE_SCHEMA = z.strictObject({
  path: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string().min(1),
  acceptedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "an ISO instant"),
});
export type FrozenAcceptance = z.infer<typeof FROZEN_ACCEPTANCE_SCHEMA>;
type FrozenManifest = Readonly<{ files: Readonly<Record<string, string>>; acceptances: readonly FrozenAcceptance[] }>;

/** A frozen file's digest as the index holds it (a flagged entry: git's view, never the disk's). */
function indexDigest(entry: FlaggedIndexEntry): string {
  if (entry.mode === "120000") return `link:${sha256(entry.bytes.toString("utf8"))}`;
  return `${entry.mode === "100755" ? "exec:" : ""}${sha256(entry.bytes)}`;
}

/**
 * Every owned file under a frozen root of the repository at `top`, with the
 * digest of its content (and its execute bit, or its link text): as it stands
 * on the disk, or — for an entry git keeps apart from the disk
 * (skip-worktree, assume-unchanged: `flagged`) — as the INDEX holds it, git's
 * view, the one a commit records.
 */
function frozenRecordDigests(top: string, flagged: ReadonlyMap<string, FlaggedIndexEntry>): Readonly<Record<string, string>> {
  const owned = ownedFiles(top);
  if (owned === undefined) throw new InputError(`not inside a git working tree: ${top}`, "record_links_repository_missing");
  const digests: Record<string, string> = {};
  for (const [path, entry] of flagged) if (isFrozenRecord(path)) digests[path] = indexDigest(entry);
  for (const path of [...owned].filter(isFrozenRecord).sort()) {
    if (flagged.has(path)) continue;
    let stat;
    try {
      stat = lstatSync(join(top, path));
    } catch (error) {
      // A tracked file deleted on the disk holds nothing: it is absent from the content, so its removal shows.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // The mode git keeps is part of the record (correctness FR-L1): an executable file's digest says so, so turning
    // the execute bit on or off is a change like any other (a plain file's digest is its content's alone, unchanged).
    digests[path] = stat.isSymbolicLink() ? `link:${sha256(readlinkSync(join(top, path)))}`
      : `${(stat.mode & 0o100) === 0 ? "" : "exec:"}${sha256(readFileSync(join(top, path)))}`;
  }
  return digests;
}

/** The manifest's text: one entry per line, sorted, so its diff names each changed record; its acceptances in order. */
function frozenRecordsText(manifest: FrozenManifest): string {
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ schemaVersion: FROZEN_RECORDS_SCHEMA, files, ...(manifest.acceptances.length === 0 ? {} : { acceptances: manifest.acceptances }) }, null, 2)}\n`;
}

/** The manifest at `top` (as the index holds it when git keeps it apart from the disk), or `undefined` when there is none. A malformed manifest is refused by name. */
function pinnedFrozenRecords(top: string, flagged: ReadonlyMap<string, FlaggedIndexEntry> = new Map()): FrozenManifest | undefined {
  const indexed = flagged.get(ROOT_POLICY.verification.frozenRecordManifest);
  if (indexed !== undefined) return parsedFrozenManifest(indexed.bytes.toString("utf8"));
  const path = join(top, ROOT_POLICY.verification.frozenRecordManifest);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parsedFrozenManifest(text);
}

/** The manifest committed at `rev` of the repository at `top`, or `undefined` when that revision holds none. */
function frozenManifestAt(top: string, rev: string): FrozenManifest | undefined {
  const text = revisionFileText(top, rev, ROOT_POLICY.verification.frozenRecordManifest, "inherited");
  return text === null ? undefined : parsedFrozenManifest(text);
}

/**
 * THE PINS NO ACCEPTANCE COVERS: every pin `manifest` changed or dropped
 * against `base`'s (the committed manifest) needs an acceptance appended since
 * `base` for exactly that change (its path, the old digest, the new one or
 * null), the acceptances `base` already had kept as they were. A hand edit of
 * the manifest that re-pins or drops a record is therefore refused by name:
 * only `harness frozen accept --reason` writes the matching acceptance.
 */
function unacceptedPins(base: FrozenManifest, manifest: FrozenManifest): readonly string[] {
  const kept = base.acceptances.every((acceptance, index) => JSON.stringify(manifest.acceptances[index]) === JSON.stringify(acceptance));
  if (!kept) return [`${ROOT_POLICY.verification.frozenRecordManifest} (an earlier acceptance was rewritten or removed)`];
  const appended = manifest.acceptances.slice(base.acceptances.length);
  return Object.keys(base.files).filter((path) => {
    // The acceptances appended since `base`, folded in order from its pin: each one that starts where the last ended.
    let reached: string | null = base.files[path]!;
    for (const acceptance of appended) if (acceptance.path === path && acceptance.from === reached) reached = acceptance.to;
    return reached !== (manifest.files[path] ?? null);
  }).sort();
}

/** The acceptances the manifest at `to` adds to the one at `from` (both revisions of the repository at `top`): what a merge lands for review. */
export function frozenAcceptancesBetween(top: string, from: string, to: string): readonly FrozenAcceptance[] {
  const before = frozenManifestAt(top, from)?.acceptances ?? [];
  return deepFreeze((frozenManifestAt(top, to)?.acceptances ?? []).slice(before.length));
}

function parsedFrozenManifest(text: string): FrozenManifest {
  const parsed = z.object({ schemaVersion: z.literal(FROZEN_RECORDS_SCHEMA), files: z.record(z.string(), z.string()), acceptances: z.array(FROZEN_ACCEPTANCE_SCHEMA).optional() }).strict().safeParse(JSON.parse(text));
  if (!parsed.success) throw new InputError(`${ROOT_POLICY.verification.frozenRecordManifest} is not a frozen-records manifest: ${parsed.error.message}`, "frozen_records_malformed");
  return { files: parsed.data.files, acceptances: parsed.data.acceptances ?? [] };
}

/** Writes the manifest at `top`. */
function writeFrozenManifest(top: string, manifest: FrozenManifest): void {
  const written = atomicWriteFile(join(top, ROOT_POLICY.verification.frozenRecordManifest), frozenRecordsText(manifest), { createMode: ROOT_POLICY.filesystem.rawFileModes.source, createParentDirectories: true });
  if (!written.success) throw new HarnessError(`${ROOT_POLICY.verification.frozenRecordManifest} could not be written: ${written.reason}`, "frozen_records_write_failed");
}

/**
 * THE ONE GENERATOR AND CHECK of the frozen roots' pinned content: with
 * `write`, a NEW frozen file's digest is added (never a pinned one changed or
 * dropped); without, any difference is drift (`stale`), naming each path. A
 * pinned record that was edited or removed stays drift, write or not, until
 * {@link acceptFrozenRecords}. A tree with no frozen file and no manifest is
 * converged by absence.
 */
export function syncFrozenRecords(top: string, write: boolean): FrozenRecordsReport {
  // GIT'S VIEW, NEVER A FLAG'S BLIND SPOT: an entry git keeps apart from the disk (skip-worktree, assume-unchanged)
  // is judged by what the index holds, and one whose disk copy is populated as well — an edit git would not see —
  // is refused, naming the flag. A narrowed copy (its flagged paths absent) is judged against its pins in full.
  const flagged = flaggedIndexEntries(top, [ROOT_POLICY.verification.frozenRecordManifest, ...ROOT_POLICY.verification.frozenRecordRoots]);
  const hidden = [...flagged].filter(([path, entry]) => entry.flag === "assume-unchanged" || lstatSync(join(top, path), { throwIfNoEntry: false }) !== undefined)
    .map(([path, entry]) => `${path} (${entry.flag})`).sort();
  if (hidden.length > 0) return deepFreeze({ status: "stale", converged: false, changed: hidden, altered: [], hidden });
  const actual = frozenRecordDigests(top, flagged);
  const manifest = pinnedFrozenRecords(top, flagged);
  if (manifest === undefined && Object.keys(actual).length === 0) return deepFreeze({ status: "absent", converged: true, changed: [], altered: [] });
  const pinned = manifest?.files ?? {};
  const altered = Object.keys(pinned).filter((path) => actual[path] !== pinned[path]).sort();
  const added = Object.keys(actual).filter((path) => pinned[path] === undefined).sort();
  const desired: FrozenManifest = { files: { ...pinned, ...Object.fromEntries(added.map((path) => [path, actual[path]!])) }, acceptances: manifest?.acceptances ?? [] };
  const indexedManifest = flagged.get(ROOT_POLICY.verification.frozenRecordManifest);
  const current = manifest === undefined ? undefined : indexedManifest !== undefined ? indexedManifest.bytes.toString("utf8") : readFileSync(join(top, ROOT_POLICY.verification.frozenRecordManifest), "utf8");
  const pending = current !== frozenRecordsText(desired);
  // A manifest git keeps apart from the disk is never written: git would not see the write.
  if (write && pending && indexedManifest !== undefined) return deepFreeze({ status: "stale", converged: false, changed: [`${ROOT_POLICY.verification.frozenRecordManifest} (${indexedManifest.flag})`], altered: [], hidden: [`${ROOT_POLICY.verification.frozenRecordManifest} (${indexedManifest.flag})`] });
  if (write && pending) writeFrozenManifest(top, desired);
  const changed = [...new Set([...altered, ...(write ? [] : added)])].sort();
  // Judged against HEAD's pins: the manifest as it stands after this call (the one written, or the one on the disk; a
  // deleted one pins nothing), so neither a hand edit nor a deleted-and-regenerated manifest re-pins history.
  const base = frozenManifestAt(top, "HEAD");
  const effective: FrozenManifest = write ? desired : manifest ?? { files: {}, acceptances: [] };
  const unaccepted = base === undefined ? [] : unacceptedPins(base, effective);
  if (unaccepted.length > 0) return deepFreeze({ status: "stale", converged: false, changed: [...new Set([...changed, ...unaccepted])].sort(), altered, unaccepted });
  if (altered.length > 0) return deepFreeze({ status: "stale", converged: false, changed, altered });
  if (pending && !write) return deepFreeze({ status: "stale", converged: false, changed: changed.length === 0 ? [ROOT_POLICY.verification.frozenRecordManifest] : changed, altered });
  return deepFreeze({ status: pending ? "regenerated" : "current", converged: true, changed: pending ? added : [], altered });
}

/** What a frozen-records report says, in one sentence: the check's step and the commit hook say it alike. */
export function frozenRecordsMessage(report: FrozenRecordsReport): string {
  if (report.converged) return `every file under a frozen record root holds its pinned content${report.status === "absent" ? " (this tree has no frozen record)" : ""}`;
  if ((report.hidden ?? []).length > 0) return `a frozen path is flagged so that git does not look at its disk bytes: ${report.hidden!.join(", ")}. An edit there would never show; clear the flag (git update-index --no-skip-worktree / --no-assume-unchanged <path>) and run the check again`;
  if ((report.unaccepted ?? []).length > 0) return `the frozen-records manifest re-pins or drops a record with no acceptance (a hand edit of ${ROOT_POLICY.verification.frozenRecordManifest}): ${report.unaccepted!.join(", ")}. Restore the pin, and accept a meant change with its reason: harness frozen accept --reason <why> <path>…`;
  return report.altered.length > 0
    ? `pinned frozen records were edited or removed — history changed: ${report.altered.join(", ")}. harness sync never re-pins one; a change that is meant is accepted explicitly, with its reason: harness frozen accept --reason <why> <path>…`
    : `new frozen records are not yet pinned: ${report.changed.join(", ")}. Run harness sync and let the manifest's diff be reviewed (a closed round's records entering).`;
}

/**
 * THE ONE DOOR THAT RE-PINS A FROZEN RECORD (`harness frozen accept --reason
 * <why> <path>…`): each named path must be a pinned record that was edited or
 * removed; it is re-pinned to what it holds now (or dropped), and the
 * acceptance — the path, the old and new digests, the reason, the instant — is
 * appended to the manifest, so the diff shows who changed history and why.
 */
export function acceptFrozenRecords(top: string, paths: readonly string[], reason: string, now: Date = new Date()): FrozenRecordsReport {
  if (reason.trim().length === 0) throw new InputError("harness frozen accept needs --reason: the reason a frozen record changed is part of the record", "frozen_accept_reason_missing");
  if (paths.length === 0) throw new InputError("harness frozen accept names at least one frozen record", "frozen_accept_paths_missing");
  const flagged = flaggedIndexEntries(top, [ROOT_POLICY.verification.frozenRecordManifest, ...ROOT_POLICY.verification.frozenRecordRoots]);
  if (flagged.size > 0) throw new InputError(`an acceptance is written into a checkout git fully sees: clear the flags first (${[...flagged].map(([path, entry]) => `${path}: ${entry.flag}`).join(", ")})`, "frozen_accept_flagged");
  const manifest = pinnedFrozenRecords(top);
  if (manifest === undefined) throw new InputError(`there is no ${ROOT_POLICY.verification.frozenRecordManifest} to accept a change into`, "frozen_accept_manifest_missing");
  const actual = frozenRecordDigests(top, flagged);
  const files: Record<string, string> = { ...manifest.files };
  const acceptances = [...manifest.acceptances];
  for (const path of [...new Set(paths)].sort()) {
    if (manifest.files[path] === undefined) throw new InputError(`${path} is no pinned frozen record (a new one is added by harness sync)`, "frozen_accept_not_pinned");
    if (actual[path] === manifest.files[path]) throw new InputError(`${path} holds its pinned content: there is nothing to accept`, "frozen_accept_unchanged");
    const to = actual[path] ?? null;
    if (to === null) delete files[path]; else files[path] = to;
    acceptances.push({ path, from: manifest.files[path], to, reason: reason.trim(), acceptedAt: now.toISOString() });
  }
  writeFrozenManifest(top, { files, acceptances });
  return syncFrozenRecords(top, false);
}

/** What a link may name: a path of the tree (a file or a folder holding one), or a recorded evidence path (or a folder of them). */
export type LinkHoldings = Readonly<{
  holds: (path: string) => boolean;
  recorded: (path: string) => boolean;
}>;

/**
 * Why the link `target` written in the document at `document` (both
 * repository-relative) names nothing, or `undefined` when it resolves. A
 * scheme other than the evidence one, and a bare anchor, are not judged. A
 * percent-encoded path resolves by its decoded spelling too.
 */
export function deadLinkReason(document: string, target: string, holdings: LinkHoldings): string | undefined {
  const path = target.split("#")[0]!;
  if (path.length === 0) return undefined;
  if (path.startsWith(LINK_SCHEME)) {
    const recorded = path.slice(LINK_SCHEME.length);
    return holdings.recorded(recorded) ? undefined : `${target} names ${recorded}, which no evidence manifest records`;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return undefined;
  // A root-relative link names a place from the repository's top; any other from the document's folder.
  const from = (spelled: string): string => posix.normalize(spelled.startsWith("/") ? spelled.slice(1) : posix.join(posix.dirname(document), spelled)).replace(/\/$/u, "");
  const resolved = from(path);
  if (holdings.holds(resolved)) return undefined;
  if (path.includes("%") && holdings.holds(from(safePercentDecode(path)))) return undefined;
  return holdings.recorded(resolved)
    ? `${target} names ${resolved}, which is held in the evidence store, not the tree: link it as ${LINK_SCHEME}${resolved}`
    : `${target} names ${resolved}, which the tree does not hold`;
}

/** The holdings of the repository at `top`: what it owns (tracked, or untracked and not ignored) and what its manifests record. */
function repositoryLinkHoldings(top: string): LinkHoldings & Readonly<{ documents: readonly string[] }> {
  const owned = ownedFiles(top);
  if (owned === undefined) throw new InputError(`not inside a git working tree: ${top}`, "record_links_repository_missing");
  const files = new Set(owned);
  const folders = new Set<string>();
  for (const file of owned) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) folders.add(parts.slice(0, depth).join("/"));
  }
  const recorded = recordedEvidence(top);
  return deepFreeze({
    holds: (path: string) => files.has(path) || folders.has(path),
    recorded: (path: string) => recordedUnder(recorded, path).length > 0,
    // The documents ON THE DISK: a working copy that carries part of the tree (the generators' copies keep the whole
    // index) has nothing to read for the rest; the links still resolve against everything the repository owns.
    documents: owned.filter((path) => path.endsWith(".md") && !isFrozenRecord(path) && lstatSync(join(top, path), { throwIfNoEntry: false })?.isFile() === true).sort(),
  });
}

/** One dead link: its ratchet key (`<document>: <target>`), and where it is (`<document>:<line>`) with why. */
export type DeadLink = Readonly<{ key: string; where: string }>;

/** Every dead link of every Markdown document the repository at `top` owns. */
export function deadMarkdownLinks(top: string): readonly DeadLink[] {
  const holdings = repositoryLinkHoldings(top);
  const dead: DeadLink[] = [];
  for (const document of holdings.documents) {
    for (const link of extractMarkdown(readFileSync(join(top, document), "utf8")).links) {
      const reason = deadLinkReason(document, link.target, holdings);
      if (reason !== undefined) dead.push({ key: `${document}: ${link.target}`, where: `${document}:${String(link.line)}: ${reason}` });
    }
  }
  return deepFreeze(dead);
}
