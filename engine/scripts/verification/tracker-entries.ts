/**
 * ONE-FILE-PER-ENTRY RECORDS: the one front-matter reader and the one checker.
 *
 * Workflow lessons (`docs/trackers/workflow-lessons/`) and decisions
 * (`docs/decisions/`) are each one Markdown file per entry, opened by a front
 * matter a machine reads:
 *
 *     ---
 *     id: L-2026-09-28-some-lesson
 *     status: acted
 *     acted_in: [engine/src/a.ts, tests/b.test.ts]
 *     ---
 *
 * Both formats are read by {@link parseFrontMatter} and judged by
 * {@link entryViolations} against a per-kind {@link EntrySchema}, so a rule
 * (a required field, an enumeration, a list of tracked paths) is spelled once.
 * The format tests, the commit guard's `Lesson:` trailer check and the
 * `lessons` report all read entries through this module.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DECISION_INDEX } from "../../src/kernel/verification-paths.ts";

/** Where each kind of entry lives, repository-relative. */
export const LESSONS_DIRECTORY = "docs/trackers/workflow-lessons";
/** The decisions live beside their generated index (`DECISION_INDEX.path`, one spelling). */
export const DECISIONS_DIRECTORY = dirname(DECISION_INDEX.path);

/** The field names and values of one front matter, in file order. */
export type FrontMatter = ReadonlyMap<string, string>;

/**
 * The front matter of `text` (between a leading `---` line and the next), or
 * `null` when the text opens with none. `body` is everything after it;
 * `duplicates` names every field spelled twice (the first value is kept, and
 * the checker refuses the entry: a second spelling silently winning was how a
 * stale status could hide below a fresh one).
 */
export function parseFrontMatter(text: string): { readonly fields: FrontMatter; readonly body: string; readonly duplicates: readonly string[] } | null {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  const duplicates: string[] = [];
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (fields.has(name)) duplicates.push(name);
    else fields.set(name, line.slice(colon + 1).trim());
  }
  return { fields, body: text.slice(match[0].length), duplicates };
}

/** A `[a, b]` list value as its items; `null` when the value is not a bracketed list. */
export function listValue(value: string): readonly string[] | null {
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  return value.slice(1, -1).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

type Condition = (fields: FrontMatter) => boolean;

/** What one field of a kind of entry must be. */
export type FieldRule = Readonly<{
  /** `true`: always required; a function: required exactly when it answers true. */
  required?: boolean | Condition;
  /** The field must be absent when this answers true. */
  forbiddenWhen?: Condition;
  /** An enumeration the value (or each list item) must belong to. */
  values?: readonly string[];
  /** A shape the value (or each list item) must match. */
  pattern?: RegExp;
  /** The value is a `[a, b]` list (at least one item when present). */
  list?: boolean;
  /** A further judgement of one value or item; returns the problem, or `null`. */
  check?: (item: string) => string | null;
}>;

/** A kind of entry: its fields and the Markdown sections its body must hold. */
export type EntrySchema = Readonly<{
  fields: Readonly<Record<string, FieldRule>>;
  sections?: readonly string[];
  /** A pattern the body must open with (e.g. a `# ` title). */
  bodyOpens?: RegExp;
}>;

/** Every way `text` breaks `schema`, each prefixed with `label`. */
export function entryViolations(label: string, text: string, schema: EntrySchema): readonly string[] {
  const parsed = parseFrontMatter(text);
  if (parsed === null) return [`${label}: no front matter`];
  const { fields, body, duplicates } = parsed;
  const problems: string[] = duplicates.map((name) => `${label}: ${name} is spelled twice`);
  for (const [name, rule] of Object.entries(schema.fields)) {
    const value = fields.get(name);
    const required = typeof rule.required === "function" ? rule.required(fields) : rule.required === true;
    if (value === undefined || value.length === 0) {
      if (required) problems.push(`${label}: ${name} is required`);
      continue;
    }
    if (rule.forbiddenWhen?.(fields) === true) {
      problems.push(`${label}: ${name} does not belong on this entry`);
      continue;
    }
    let items: readonly string[] = [value];
    if (rule.list === true) {
      const listed = listValue(value);
      if (listed === null || listed.length === 0) {
        problems.push(`${label}: ${name} must be a non-empty [a, b] list`);
        continue;
      }
      items = listed;
    }
    for (const item of items) {
      if (rule.values !== undefined && !rule.values.includes(item)) problems.push(`${label}: ${name} must be one of ${rule.values.join(", ")} (was ${item})`);
      else if (rule.pattern !== undefined && !rule.pattern.test(item)) problems.push(`${label}: ${name} ${item} does not match ${String(rule.pattern)}`);
      else {
        const problem = rule.check?.(item) ?? null;
        if (problem !== null) problems.push(`${label}: ${name} ${problem}`);
      }
    }
  }
  if (schema.bodyOpens !== undefined && !schema.bodyOpens.test(body)) problems.push(`${label}: the body must open with ${String(schema.bodyOpens)}`);
  for (const section of schema.sections ?? []) if (!`\n${body}`.includes(`\n${section}`)) problems.push(`${label}: missing ${section}`);
  return problems;
}

/** Each `.md` entry of `directory` (not its README) with its text. */
export function readEntries(root: string, directory: string): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => ({ name, text: readFileSync(join(root, directory, name), "utf8") }));
}

// ── Workflow lessons ────────────────────────────────────────────────────────

const LESSON_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;
export const LESSON_KINDS = Object.freeze(["tooling", "guard", "doc", "config", "process", "environment"] as const);
export const LESSON_STATUSES = Object.freeze(["pending", "acted", "wontfix"] as const);

/** A lesson's id from its file name (`L-<stem>`). */
export function lessonId(name: string): string {
  return `L-${name.slice(0, -".md".length)}`;
}

/**
 * `acted_in` names repository-relative paths, never a commit SHA: a hand-typed
 * SHA is a hand-edited generated value, and the commit that acts cannot
 * contain its own. The link to the commit is its `Lesson:` trailer.
 *
 * WHETHER GIT HOLDS each path is judged when the entry is written — the commit
 * that adds or changes it (`tracked` given: the staged tree,
 * `stagedTrackerEntryViolations` in `lesson-trailers.ts`) — and never again:
 * a closed record names where the work was done THEN, and a later rename or
 * deletion of that file must not turn the record red or force it to be
 * rewritten (wf-1b3a-design M2). Without `tracked`, only the shape is judged.
 */
function actedInCheck(tracked: ReadonlySet<string> | undefined): (item: string) => string | null {
  return (item) => {
    if (/^[0-9a-f]{7,40}$/u.test(item)) return `${item} is a commit id; name the tracked paths, and link the commit with its Lesson: trailer`;
    if (item.startsWith("/") || item.startsWith("~") || item.split("/").includes("..")) return `${item} is not a repository-relative path`;
    return tracked === undefined || tracked.has(item) ? null : `${item} is not a path git holds (tracked or staged)`;
  };
}

/** Every way the lesson file `name` with `text` breaks the lesson format. */
export function lessonViolations(name: string, text: string, tracked?: ReadonlySet<string>): readonly string[] {
  const nameMatch = LESSON_NAME.exec(name);
  if (nameMatch === null) return [`${name}: the name must be <YYYY-MM-DD>-<slug>.md`];
  const status = (fields: FrontMatter): string | undefined => fields.get("status");
  // A field belongs to its status alone — judged only once the status is one we know (an unknown one is its own refusal).
  const knownStatusOtherThan = (wanted: string) => (fields: FrontMatter): boolean => (LESSON_STATUSES as readonly string[]).includes(status(fields) ?? "") && status(fields) !== wanted;
  return entryViolations(name, text, {
    fields: {
      id: { required: true, values: [lessonId(name)] },
      date: { required: true, values: [nameMatch[1]!] },
      source: { required: true },
      kind: { required: true, values: LESSON_KINDS },
      status: { required: true, values: LESSON_STATUSES },
      route: { required: (fields) => status(fields) === "pending", forbiddenWhen: knownStatusOtherThan("pending") },
      acted_in: { required: (fields) => status(fields) === "acted", forbiddenWhen: knownStatusOtherThan("acted"), list: true, check: actedInCheck(tracked) },
      reason: { required: (fields) => status(fields) === "wontfix", forbiddenWhen: knownStatusOtherThan("wontfix") },
    },
    sections: ["## Observation", "## Lesson", "## Change"],
  });
}

// ── Decisions ───────────────────────────────────────────────────────────────

/**
 * A decision id: upper-case words and numbers joined by hyphens, as the plan
 * and the specs cite them (`D-04`, `D-R1`, `UD-C1`, `U2`, `CFG-DIR`), each
 * part optionally ending in one lower-case variant letter (`X3b`: option b).
 */
export const DECISION_ID = /^[A-Z][A-Z0-9]*[a-z]?(?:-[A-Z0-9]+[a-z]?)*$/u;
export const DECISION_BY = Object.freeze(["user", "coordinator"] as const);
export const DECISION_STATUSES = Object.freeze(["in-force", "superseded"] as const);
/**
 * How far a decision is carried out: `standing` binds all work and is never
 * "done"; `pending` and `partial` name the task that carries it (`route`);
 * `done` and `partial` name where (`acted_in`).
 */
export const DECISION_IMPLEMENTATIONS = Object.freeze(["standing", "pending", "partial", "done"] as const);
/** The index's sections (`group` in each decision's front matter), in the index's order, with their headings. */
export const DECISION_GROUPS = Object.freeze({
  "user-rules": "User rules (standing)",
  process: "Process decisions (coordinator)",
  engine: "Earlier engine decisions (coordinator)",
  "prompt-cache": "Prompt cache",
  configuration: "Configuration, prompts and credentials",
  promotion: "Promotion",
  responses: "The Responses sequence",
  scale: "Scale",
  memory: "Memory layers",
  labs: "Labs (docs, browser, intelligence)",
} as const);

/**
 * Every way the decision files `entries` break the decision format, judged
 * together: ids and their `covers` aliases are unique; `superseded_by` and
 * `overrides` name OTHER ids that exist; every supersession chain ends at a
 * decision in force, without a cycle.
 */
export function decisionViolations(entries: readonly { readonly name: string; readonly text: string }[], tracked?: ReadonlySet<string>): readonly string[] {
  const known = new Map<string, string>();
  const problems: string[] = [];
  for (const { name, text } of entries) {
    const fields = parseFrontMatter(text)?.fields;
    for (const id of [fields?.get("id") ?? "", ...(listValue(fields?.get("covers") ?? "") ?? [])]) {
      if (id.length === 0) continue;
      const holder = known.get(id);
      if (holder !== undefined) problems.push(`${name}: the id ${id} is also ${holder}'s`);
      known.set(id, name);
    }
  }
  const implementation = (fields: FrontMatter): string | undefined => fields.get("implementation");
  const carriesOut = (fields: FrontMatter): boolean => ["done", "partial"].includes(implementation(fields) ?? "");
  const routed = (fields: FrontMatter): boolean => ["pending", "partial"].includes(implementation(fields) ?? "");
  // Judged only once the implementation is one we know (an unknown one is its own refusal).
  const knownImplementation = (fields: FrontMatter): boolean => (DECISION_IMPLEMENTATIONS as readonly string[]).includes(implementation(fields) ?? "");
  const fieldsOf = new Map<string, FrontMatter>();
  for (const { text } of entries) {
    const fields = parseFrontMatter(text)?.fields;
    if (fields === undefined) continue;
    for (const alias of [fields.get("id") ?? "", ...(listValue(fields.get("covers") ?? "") ?? [])]) if (alias.length > 0 && !fieldsOf.has(alias)) fieldsOf.set(alias, fields);
  }
  for (const { name, text } of entries) {
    const id = parseFrontMatter(text)?.fields.get("id") ?? "";
    const knownId = (item: string): string | null => (item === id ? `${item} is this decision itself` : known.has(item) ? null : `${item} names no decision`);
    if (DECISION_ID.test(id) && !name.startsWith(`${id}-`)) problems.push(`${name}: its id ${id} does not name it`);
    // A supersession chain ends at a decision in force: never a cycle, never a dead end.
    const seen = new Set<string>([id]);
    const successor = fieldsOf.get(id)?.get("superseded_by");
    // (A decision superseded by ITSELF is refused once, by its field's own check.)
    for (let next = successor === id ? undefined : successor; next !== undefined && known.has(next); next = fieldsOf.get(next)?.get("superseded_by")) {
      if (seen.has(next)) { problems.push(`${name}: its supersession chain returns to ${next}`); break; }
      seen.add(next);
      if (fieldsOf.get(next)?.get("status") === "in-force") break;
      if (fieldsOf.get(next)?.get("superseded_by") === undefined) { problems.push(`${name}: its supersession chain ends at ${next}, which is not in force`); break; }
    }
    problems.push(...entryViolations(name, text, {
      fields: {
        id: { required: true, pattern: DECISION_ID },
        date: { required: true, pattern: /^\d{4}-\d{2}-\d{2}$/u },
        by: { required: true, values: DECISION_BY },
        status: { required: true, values: DECISION_STATUSES },
        superseded_by: { required: (fields) => fields.get("status") === "superseded", forbiddenWhen: (fields) => fields.get("status") !== "superseded", check: knownId },
        overrides: { list: true, check: knownId },
        covers: { list: true, pattern: DECISION_ID },
        group: { required: true, values: Object.keys(DECISION_GROUPS) },
        implementation: { required: true, values: DECISION_IMPLEMENTATIONS },
        route: { required: routed, forbiddenWhen: (fields) => knownImplementation(fields) && !routed(fields) },
        acted_in: { required: carriesOut, forbiddenWhen: (fields) => knownImplementation(fields) && !carriesOut(fields), list: true, check: actedInCheck(tracked) },
      },
      bodyOpens: /^# \S/u,
    }));
  }
  return problems;
}

// ── The decision index (docs/decisions/README.md) ──────────────────────────

/** One decision's index row: its id and file, its title (with the ids it covers), its author, its state. */
function indexRow(name: string, fields: FrontMatter, title: string): string {
  const covers = listValue(fields.get("covers") ?? "") ?? [];
  const state = fields.get("status") === "superseded"
    ? `superseded by ${fields.get("superseded_by") ?? "?"}`
    : `${fields.get("implementation") ?? "?"}${fields.get("route") === undefined ? "" : ` (${fields.get("route")!})`}`;
  return `| [${fields.get("id") ?? "?"}](${name}) | ${title}${covers.length === 0 ? "" : ` (covers ${covers.join(", ")})`} | ${fields.get("by") ?? "?"} | ${state} |`;
}

/**
 * THE DECISION INDEX, generated from the decision files alone (their front
 * matter and `# ` title): one section per {@link DECISION_GROUPS} entry that
 * holds a decision, the rows in file-name order. It is the text between the
 * `DECISION_INDEX` markers (src/kernel/verification-paths.ts); nothing in it is typed by hand
 * (wf-1b3a-design M1: a hand-kept index restated every file's state and could
 * lie after a `pending → done` flip).
 */
export function renderDecisionIndex(entries: readonly { readonly name: string; readonly text: string }[]): string {
  const sections = Object.entries(DECISION_GROUPS).flatMap(([group, heading]) => {
    const rows = entries.flatMap(({ name, text }) => {
      const parsed = parseFrontMatter(text);
      if (parsed === null || parsed.fields.get("group") !== group) return [];
      return [indexRow(name, parsed.fields, /^# (.+)$/mu.exec(parsed.body)?.[1]?.trim() ?? name)];
    });
    return rows.length === 0 ? [] : [`## ${heading}\n\n| Id | Decision | By | State |\n|---|---|---|---|\n${rows.join("\n")}\n`];
  });
  return sections.join("\n");
}

/**
 * The README `readme` with its generated block replaced by `index`, or
 * `null` when the README carries no (or a torn) block: a README without the
 * markers is refused, never silently left ungenerated.
 */
export function withDecisionIndex(readme: string, index: string): string | null {
  const begin = readme.indexOf(DECISION_INDEX.begin);
  const end = readme.indexOf(DECISION_INDEX.end);
  if (begin < 0 || end < begin) return null;
  return `${readme.slice(0, begin + DECISION_INDEX.begin.length)}\n\n${index}\n${readme.slice(end)}`;
}
