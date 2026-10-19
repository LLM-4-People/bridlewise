/**
 * THE INDEX'S ENTRIES — the one `git ls-files --stage` reader.
 *
 * Every question "what does this index hold, entry by entry?" is answered
 * here: the live index baseline (`index-baseline.ts`) and the candidate
 * manifest (through its pinned git, which hands its own records to
 * {@link parseIndexRecords}). One entry type, one record grammar, one typed
 * refusal for a record that does not parse. Which git answers — the caller's
 * environment (a hook's index) or the directory's own — is a parameter, never
 * a second reader.
 */
import { HarnessError } from "../kernel/errors.ts";
import { GIT_OBJECT_NAME_PATTERN } from "./git-port.ts";
import { gitNulRecords, type GitEnvironment } from "./repository-ownership.ts";

/** One index entry, as `git ls-files --stage` states it. */
export type IndexEntry = Readonly<{ path: string; mode: string; objectId: string; stage: number }>;

/** One `ls-files --stage` record: `<mode> SP <object> SP <stage> TAB <path>`. */
const INDEX_RECORD = new RegExp(`^(\\d{6}) (${GIT_OBJECT_NAME_PATTERN}) ([0-3])\\t([\\s\\S]+)$`, "u");

/** `<mode> SP <object> SP <stage> TAB <path>` records (from `-z` output) as entries. */
export function parseIndexRecords(records: readonly string[]): readonly IndexEntry[] {
  return Object.freeze(records.map((record) => {
    const match = INDEX_RECORD.exec(record);
    if (match === null) throw new HarnessError("Invalid Git index record", "repository_git_index_invalid", false);
    return Object.freeze({ path: match[4]!, mode: match[1]!, objectId: match[2]!, stage: Number(match[3]) });
  }));
}

/** Every entry of the index git answers for `root` in `environment` (`-z`: a path arrives raw). */
export function indexEntries(root: string, environment: GitEnvironment): readonly IndexEntry[] {
  return parseIndexRecords(gitNulRecords(root, ["ls-files", "--stage", "-z"], environment));
}

/**
 * The paths holding an INTENT-TO-ADD entry (`git add -N`): `ls-files --stage`
 * shows it as the empty blob with no flag, and it is the only kind of entry
 * `diff-files` reports as ADDED (a real entry differs from its file as
 * modified or deleted).
 */
export function intentToAddPaths(root: string, environment: GitEnvironment): readonly string[] {
  return gitNulRecords(root, ["diff-files", "--name-only", "--diff-filter=A", "-z"], environment);
}
