/**
 * THE KEY HOME — where every harness key lives, and the registry of the
 * harness stores those keys belong to. Part of the confinement owner: the key
 * home is one entry of the keep-out list (`keep-out.ts`), so no confined
 * process, project or file door can reach any key; the registry makes every
 * harness database this user ever opened a keep-out entry too, BY IDENTITY,
 * wherever it lives (other checkouts, labs, custom database folders, the
 * legacy `.code-harness` layout once registered, the pre-migration copies).
 *
 * ── WHY OUTSIDE THE STATE FOLDER ──────────────────────────────────────────
 *
 * The key used to sit beside its database (`<state folder>/db-key`), so any
 * grant, project or file read that reached the state folder — of this
 * checkout, or of any other the user had (measured: five real keys opened
 * under the real guardian through admitted grants) — reached the key that
 * decrypts it. One per-user folder outside every checkout makes "no key is
 * reachable" a single identity check. An install that still keeps its key
 * beside its database is refused by shape, registered or not
 * (`database-files.ts` `legacyInstallIn`, `keep-out.ts`).
 *
 * Location (the boot tier, read and admitted by the one private-home owner,
 * `../private-home.ts`; a host admits it ONCE and passes the admitted home
 * on): the operator's override
 * `ROOT_POLICY.selfProtection.keyHome.environmentVariable`, else
 * `$XDG_CONFIG_HOME/<relative>`, else `~/.config/<relative>`. A key file is
 * named by the resolved folder of its database (`<digest>.key`), so the
 * databases of one state folder share one key, as they always have.
 */

import { atomicWriteFile } from "../atomic-write.ts";
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { hasErrorCode } from "../../kernel/errors.ts";
import { engineRoot } from "../../kernel/engine-root.ts";
import { canonicalJson, sha256 } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { handleError } from "../../shared/debug/debug-system.ts";
import { resolveLocation, type ResolvedAbsolutePath } from "../path-identity.ts";
import { admitPrivateHome, KEY_HOME, privateHomeLocation, type PrivateHomeNeighbour } from "../private-home.ts";
import { PRE_REKEY_MARKER } from "../database-files.ts";
import { ABSOLUTE_PATH } from "./self-protection-config.ts";
import { PRIVATE_STATE_DIRECTORY_MODE, PRIVATE_STATE_FILE_MODE } from "../private-state.ts";

const POLICY = ROOT_POLICY.selfProtection.keyHome;

/** Hex characters of the folder digest a key file is named by. */
const KEY_NAME_DIGEST_CHARS = 32;
const KEY_NAME = new RegExp(`^[0-9a-f]{${KEY_NAME_DIGEST_CHARS}}$`, "u");

declare const ADMITTED_KEY_HOME: unique symbol;
/** A key home that {@link admitKeyHome} created or checked: private, ours, disjoint. */
export type AdmittedKeyHome = ResolvedAbsolutePath & { readonly [ADMITTED_KEY_HOME]: true };

/** A place the key home must share nothing with, and what to call it in a refusal. */
export type KeyHomeNeighbour = PrivateHomeNeighbour;

/**
 * Where the key home is, from the environment as it is now (nothing is
 * created) — the private-home owner's boot read. A PROCESS UNDER TEST never
 * picks one: our runners (the root vitest config, the engine runner) export a
 * private key home to every descendant, and a process the checkout write door
 * finds under test without one is REFUSED (`key_home_unset_under_test`) — it
 * would otherwise register test databases in, and mint keys into, the user's
 * own key home.
 */
export function keyHomeLocation(): string {
  return privateHomeLocation(KEY_HOME);
}

/**
 * ADMIT a key home at `location` through the one private-home admission
 * (`private-home.ts`: a real folder of this user, never a link, closed to
 * group and other, disjoint from every neighbour), then bring the registry's
 * records to the current record format (the admission is the one moment a
 * process writes the key home's layout).
 */
export function admitKeyHome(location: string, neighbours: readonly KeyHomeNeighbour[]): AdmittedKeyHome {
  const home = admitPrivateHome(KEY_HOME, location, neighbours);
  upgradeStoreRecords(home);
  return home as AdmittedKeyHome;
}

/**
 * THE ONE ADMISSION OF THE HARNESS'S KEY HOME (the location the environment
 * names): every host — the web server at boot, the engine's timeline store,
 * the key tool — asks here with the stores it is about to key, and the
 * neighbours are computed HERE, the same for all: this engine checkout, the
 * system temp folder, each store's folder, and whatever the host alone knows
 * (the web server: its repository and its declared project roots).
 */
export function admitHarnessKeyHome(stores: readonly string[], hostNeighbours: readonly KeyHomeNeighbour[] = []): AdmittedKeyHome {
  return admitKeyHome(keyHomeLocation(), [
    { path: engineRoot(), what: "the harness checkout" },
    { path: tmpdir(), what: "the system temp folder" },
    ...stores.filter((store) => store !== ":memory:").map((store) => ({ path: dirname(resolve(store)), what: `the folder of ${resolve(store)}` })),
    ...hostNeighbours,
  ]);
}

/** THE NAME of the key the database at `dbPath` uses: the digest of its resolved folder. */
export function databaseKeyName(dbPath: string): string {
  return sha256(resolveLocation(dirname(resolve(dbPath)), "a harness store's folder")).slice(0, KEY_NAME_DIGEST_CHARS);
}

/**
 * The key file of the database at `dbPath` (shared by every database of its
 * folder). `retired` — the material a re-key retired — names THAT material's
 * own slot (`….pre-rekey-<fingerprint>`): every re-key keeps its retired key
 * in a slot of its own, so a second re-key never replaces the key the
 * pre-re-key copy and every earlier pre-migration copy still open under
 * (sec-e-correctness M-1: one replaced slot made them unopenable).
 */
export function databaseKeyFile(keyHome: AdmittedKeyHome, dbPath: string, retired?: Uint8Array): string {
  return join(keyHome, `${databaseKeyName(dbPath)}${POLICY.keySuffix}${retiredSlotSuffix(retired)}`);
}

/** Where passphrase mode keeps that folder's salt (not a secret; beside the key it replaces); `retired` as for the key. */
export function databaseSaltFile(keyHome: AdmittedKeyHome, dbPath: string, retired?: Uint8Array): string {
  return join(keyHome, `${databaseKeyName(dbPath)}${POLICY.keySuffix}${POLICY.saltSuffix}${retiredSlotSuffix(retired)}`);
}

/** A retired material's slot suffix: the marker and the material's fingerprint (a digest of 256 random bits reveals none of them). */
function retiredSlotSuffix(retired: Uint8Array | undefined): string {
  return retired === undefined ? "" : `${PRE_REKEY_MARKER}-${sha256(retired).slice(0, KEY_NAME_DIGEST_CHARS)}`;
}

/**
 * THE BINDING RECORD of the key the database at `dbPath` uses (one per key,
 * whatever its mode): present once that key has sealed bound fields. See
 * `ROOT_POLICY.selfProtection.keyHome.boundSuffix`.
 */
export function databaseBindingRecord(keyHome: AdmittedKeyHome, dbPath: string): string {
  return join(keyHome, `${databaseKeyName(dbPath)}${POLICY.boundSuffix}`);
}

// ── The registry of harness stores ─────────────────────────────────────────

const RECORD_VERSION = schemaId("harness-store-record", 2);
const STORE_RECORD_SCHEMA = z.strictObject({
  schemaVersion: z.literal(RECORD_VERSION),
  path: ABSOLUTE_PATH,
  /** The name of the key this store is sealed with ({@link databaseKeyName} of the database that owns the key). */
  key: z.string().regex(KEY_NAME),
});
/** The first record format: `{path}` only — its key was always its own folder's. */
const STORE_RECORD_V1_SCHEMA = z.strictObject({ schemaVersion: z.literal(schemaId("harness-store-record", 1)), path: ABSOLUTE_PATH });

/** One registered store: where it is and which key seals it. */
export type HarnessStoreRecord = Readonly<{ path: string; key: string }>;

function storesDirectory(keyHome: string): string {
  return join(keyHome, POLICY.storesDirectory);
}

function recordFile(keyHome: string, storePath: string): string {
  return join(storesDirectory(keyHome), `${sha256(storePath).slice(0, KEY_NAME_DIGEST_CHARS)}.json`);
}

/** Bumped by every registration this process makes: a cheap part of the registry's generation. */
let registrations = 0;

/**
 * RECORD a harness store (a database file) in the key home's registry: one
 * private file per store, published complete (the one atomic writer), so a
 * concurrent lister never reads a half-written record. `keyDatabase` names
 * the database whose key seals it (a timeline shares the web database's key,
 * wherever the timeline lives). Idempotent; a record that says something else
 * (another key) is replaced.
 */
export function registerHarnessStore(keyHome: AdmittedKeyHome, storePath: string, keyDatabase: string = storePath): void {
  const path = resolveLocation(resolve(storePath), "a harness store");
  const directory = storesDirectory(keyHome);
  if (mkdirSync(directory, { recursive: true, mode: PRIVATE_STATE_DIRECTORY_MODE }) !== undefined) chmodSync(directory, PRIVATE_STATE_DIRECTORY_MODE);
  const record = recordFile(keyHome, path);
  const content = canonicalJson({ schemaVersion: RECORD_VERSION, path, key: databaseKeyName(keyDatabase) });
  let present: string | undefined;
  try { present = readFileSync(record, "utf8"); } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    present = undefined;
  }
  if (present === content) return;
  const written = atomicWriteFile(record, content, { exclusive: present === undefined, durable: true, exactMode: PRIVATE_STATE_FILE_MODE, createParentDirectories: false });
  registrations += 1;
  if (written.success || (written.error as { code?: unknown } | undefined)?.code === "EEXIST") return;
  throw written.error;
}

/** Remove one store's record (the key tool's `forget`, for a store deleted on purpose); true when one was removed. */
export function forgetHarnessStore(keyHome: AdmittedKeyHome, storePath: string): boolean {
  try {
    unlinkSync(recordFile(keyHome, resolveLocation(resolve(storePath), "a harness store")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  registrations += 1;
  return true;
}

/** A record's file name: the store's path digest, `.json`. */
const STORE_RECORD_NAME = new RegExp(`^[0-9a-f]{${KEY_NAME_DIGEST_CHARS}}\\.json$`, "u");

/** The published record names (the atomic writer's in-flight temporary sits in the same folder and is never read). */
function recordNames(keyHome: string): readonly string[] {
  try {
    return readdirSync(storesDirectory(keyHome)).filter((name) => STORE_RECORD_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

/** Rewrite every first-format record in the current format (its key: its own folder's, as the first format meant). */
function upgradeStoreRecords(keyHome: string): void {
  for (const name of recordNames(keyHome)) {
    const file = join(storesDirectory(keyHome), name);
    try {
      const parsed = STORE_RECORD_V1_SCHEMA.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) continue;
      const content = canonicalJson({ schemaVersion: RECORD_VERSION, path: parsed.data.path, key: databaseKeyName(parsed.data.path) });
      const written = atomicWriteFile(file, content, { durable: true, exactMode: PRIVATE_STATE_FILE_MODE, createParentDirectories: false });
      if (!written.success) throw written.error;
      registrations += 1;
    } catch (error) {
      handleError(error, { module: "filesystem/self-protection/key-home", operation: "upgradeStoreRecords", record: file });
    }
  }
}

/**
 * THE REGISTRY, AN EXPLICIT DEPENDENCY: the hosts open it once (with the key
 * home they admitted) and hand it to the keep-out list (`KeepOutFacts`), the
 * key tool and the signals; a test hands an empty one. Reading never changes
 * the key home: a record whose store is missing right now (a restore by `mv`,
 * an unmounted drive) is kept — the place stays kept out, by name under its
 * folder — and only the key tool forgets one.
 */
export type HarnessStoreRegistry = Readonly<{
  keyHome: string;
  /** Every record (read again only when the generation moved). */
  records: () => readonly HarnessStoreRecord[];
  /** A token that changes whenever the set of records may have: this process's registrations and the published names. */
  generation: () => string;
  /** The stores sealed with the key named `key` ({@link databaseKeyName}). */
  sharingKey: (key: string) => readonly string[];
}>;

export function openStoreRegistry(keyHome: string): HarnessStoreRegistry {
  let cached: Readonly<{ generation: string; records: readonly HarnessStoreRecord[] }> | undefined;
  const generation = (): string => `${registrations}:${sha256(recordNames(keyHome).join("\n"))}`;
  const records = (): readonly HarnessStoreRecord[] => {
    const now = generation();
    if (cached?.generation === now) return cached.records;
    const read: HarnessStoreRecord[] = [];
    for (const name of recordNames(keyHome)) {
      const file = join(storesDirectory(keyHome), name);
      try {
        const parsed = STORE_RECORD_SCHEMA.parse(JSON.parse(readFileSync(file, "utf8")));
        read.push(Object.freeze({ path: parsed.path, key: parsed.key }));
      } catch (error) {
        // Unreadable (or a first-format record no admission upgraded yet):
        // reported, never deleted — the key tool decides.
        handleError(error, { module: "filesystem/self-protection/key-home", operation: "openStoreRegistry.records", record: file });
      }
    }
    cached = Object.freeze({ generation: now, records: Object.freeze(read.sort((a, b) => a.path.localeCompare(b.path))) });
    return cached.records;
  };
  return Object.freeze({
    keyHome,
    records,
    generation,
    sharingKey: (key: string) => records().filter((record) => record.key === key).map((record) => record.path),
  });
}
