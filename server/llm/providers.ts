import { RESPONSES_REQUEST_SCHEMA } from "../../engine/src/shared/llm/responses.ts";
/**
 * MODEL PROVIDERS — the ONE source, and it is the database.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
 *
 * Until this module, "which provider does a run talk to?" had three answers
 * living in three places, and they disagreed:
 *
 *   1. `bridlewise.config.json` supplied the provider list and base URLs.
 *   2. `a local operator config` supplied the base URL AND the API
 *      key actually used — a world-readable path in a temp directory that no
 *      user was ever told about, read at server start, silently absent on a
 *      fresh machine.
 *   3. `HARNESS_WEB_DEFAULT_MODEL` / a hard-coded model id supplied the model,
 *      overriding whatever the config file said.
 *
 * Every one of those is a FALLBACK SOURCE: a second place to go looking for
 * one answer. A fallback only fires when the real source is missing, which is
 * precisely the moment nobody is watching, and it converts a clear "you have
 * not set this up yet" into a confusing "it works, but not the way you
 * configured it". All three are deleted. A provider that is not saved in the
 * database does not exist.
 *
 * ── WHAT MAKES THE DELETION STICK ─────────────────────────────────────────
 *
 * Deleting a file read is a change a later edit can undo in one line. So the
 * shape is changed instead of the code being merely removed:
 *
 *   `SharedLLMClient` is no longer constructible from a `{baseUrl, apiKey}`
 *   object. It is constructed from a {@link ProviderCredential}, whose brand
 *   is a module-private symbol declared HERE.
 *
 * A future edit that re-adds a file read therefore does not compile from
 * nothing: it can obtain a base URL and a key from anywhere it likes and has
 * no way to SPELL a value of this type from scratch.
 *
 * ── WHAT THE BRAND ACTUALLY BUYS, MEASURED RATHER THAN ASSERTED ───────────
 *
 * This paragraph used to read: *"No other module can name that symbol, so no
 * other module can produce the value — `JSON.parse` of a config file cannot,
 * an object literal cannot, a fixture cannot."* The three named forms are
 * genuinely refused (TS2741 / TS2345 / TS2352). The sentence around them was
 * false, and eleven attacks were compiled to find out which: **six compile,
 * and two of those need no cast at all.**
 *
 *   - `{ ...credential, baseUrl: "https://evil.example", apiKey: () => "x" }`
 *     COMPILES, because an object spread COPIES A SYMBOL-KEYED PROPERTY. The
 *     result is a fully valid credential pointing anywhere, with no `as`
 *     anywhere in it. Driven at run time, not inferred.
 *   - `Object.assign(credential, { … })` COMPILES and used to MUTATE THE
 *     GENUINE CREDENTIAL IN PLACE — `real.example` became `evil.example` on
 *     the very object the bridge was about to build a client from, brand
 *     intact. That half is closed below: the mint freezes what it returns, so
 *     the assignment now throws in strict mode instead of succeeding.
 *   - `as unknown as`, `as any`, `structuredClone` and a JSON round-trip
 *     compile, as they do for every TypeScript brand.
 *
 * So the honest claim is the narrower one: **a brand stops a value being
 * SPELLED from nothing; it does not stop a value being DERIVED from one you
 * already hold.** Deriving requires already holding a genuine credential,
 * which means already being inside the one module the mint hands them to.
 * That is a real reduction in surface and it is not unforgeability, and the
 * difference is worth stating because the guard that protects sole-
 * producership is a TEXT SCAN over `PROVIDER_CREDENTIAL_BRAND`, and a spread
 * never writes those letters.
 *
 * THE SPREAD NOW LANDS ON A RUNTIME REFUSAL. The mint records every
 * credential it constructs in a module-private `WeakMap`, and the bridge
 * consults it (`admitMintedCredential`) at the one place a credential
 * becomes a network client — so the driven no-cast derivation
 * (`{ ...credential, baseUrl: "https://evil.example" }`, which keeps the
 * GENUINE key closure while pointing it anywhere) is a different object,
 * is not in the set, and is refused typed before a socket opens. Membership
 * is the credential; the copied brand proves nothing.
 *
 * ── AND THE KEY NEVER BECOMES A FIELD, ON EITHER SHAPE ────────────────────
 *
 * The API key is reachable only through the `apiKey()` METHOD, closed over
 * rather than stored as a property. A credential therefore cannot leak through
 * the mechanisms that leak everything else: `JSON.stringify(credential)` emits
 * no key, a structured log of the object emits no key, an error that
 * interpolates it emits no key, and spreading it into a ledger row copies no
 * key. Reaching the secret requires calling a method, which is an act nobody
 * performs by accident.
 *
 * THE CREDENTIAL WAS SAFE AND ITS CONTAINER WAS NOT. `JSON.stringify(store)`
 * and `util.inspect(store)` both emitted `apiKey: "sk-…"` verbatim, and that
 * store is what {@link loadProviderStore} hands to every route — so the one
 * object a route is most likely to log was the one object that printed the
 * secret. The write shape and the read shape were the SAME type, and a type
 * that must carry a plain string for the database cannot also refuse to print
 * one. They are now two types: {@link ProviderDocument} is the write shape and
 * is the only shape in which the key is a string, and {@link ProviderStore} —
 * the shape everything reads — carries the key the same way the credential
 * does, as a call. A serialiser cannot find a string that is not there.
 *
 * Minting also registers the key with the redaction identity layer, at the
 * mint, so a key cannot enter this process without the redactor learning it.
 * Doing that at the call sites instead would be one more thing to forget.
 */

import { z } from "zod";
import { isProviderBaseUrl } from "../../engine/src/shared/llm/provider-endpoint.ts";

import type { AsyncDbClient } from "../db/async-client.ts";
import {
  ForgedProviderCredentialError,
  ProviderNotConfiguredError,
  ValidationError,
} from "../kernel/errors.ts";
import { isSensitiveKey } from "./redaction.ts";
import { canonicalHeaderName } from "../kernel/canonical.ts";
import { privateAddressesAllowedFor } from "../../engine/src/shared/outbound-policy.ts";

// ── The remedy sentence: ONE owner, read by the run path AND by the UI ─────

/**
 * What the user must do, in plain words, with no internal vocabulary and no
 * path they were never told about.
 *
 * Every refusal in this file ends with this sentence, the run path throws
 * those refusals unchanged, and `GET /api/models` hands the same string to the
 * setup surface. One spelling means the sentence a user reads when a run
 * refuses is byte-identical to the one the settings page shows them, so the
 * two cannot drift into describing different remedies.
 */
export const PROVIDER_SETUP_REMEDY =
  "Open Settings and add a model provider: a name for it, the address of its API, " +
  "your API key, and at least one model name it serves.";

// ── The stored shape ──────────────────────────────────────────────────────

/**
 * A model a provider serves. `contextWindow` is what the model can hold in
 * one request (input and output together) — the fact the compose-time
 * estimate and the trim budget reason about. `maxTokens` and `temperature`
 * are per-model request defaults. Each is optional, and absent means "let
 * the provider decide", which is a real answer rather than a guessed
 * number: a provider asked beyond what it can hold refuses the request, so
 * an undeclared window falls back to the harness-wide limit while a
 * declared one is honoured exactly as written.
 */
const STORED_MODEL = z.strictObject({
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: RESPONSES_REQUEST_SCHEMA.shape.max_output_tokens.unwrap().unwrap().optional(),
  temperature: RESPONSES_REQUEST_SCHEMA.shape.temperature.unwrap().unwrap().optional(),
});

/**
 * A saved provider.
 *
 * `apiKey` is OPTIONAL IN THE SCHEMA AND REQUIRED IN PRACTICE, and the
 * asymmetry is deliberate. Rejecting a keyless provider at the schema would
 * make the row unreadable, which turns "you still owe this provider a key"
 * into "your provider vanished" — the crash-instead-of-guidance failure this
 * whole module exists to remove. So a keyless provider is stored, listed, and
 * shown as incomplete, and it simply cannot mint a credential: a run that
 * selects it refuses BY NAME and says which provider is missing its key.
 *
 * `headers` are extra HTTP headers the provider's endpoint requires beyond
 * the API key (a proxy's `X-Org-Id`, a routing tag). They ride on every
 * request the engine sends to this provider — the engine merges them over
 * the base set in `shared/llm/client.ts`. A header is a CREDENTIAL when its
 * name says so: the same catalogue that gates config writes and drives
 * key-based redaction decides that (`isSensitiveKey`), so `Authorization`,
 * `X-API-Key`, `Cookie` and their kin are REFUSED here rather than sent,
 * redacted later, or silently overriding the key. A header named
 * `Authorization` cannot pass at all: if a provider genuinely needs a static
 * bearer different from the saved key, the key IS that bearer — saving it in
 * `apiKey` is the one door, so there is exactly one credential per provider
 * and no second place it could drift from.
 */
const STORED_PROVIDER = z.strictObject({
  id: z.string().min(1),
  baseUrl: z.string().min(1).refine(isProviderBaseUrl, "Use an HTTP or HTTPS API address without credentials, query parameters or a fragment."),
  apiKey: z.string().min(1).optional(),
  models: z.array(STORED_MODEL).default([]),
  headers: z.record(z.string(), z.string()).optional(),
}).check((ctx) => {
  // ── A HEADER THE KEY CATALOGUE CALLS SENSITIVE IS NOT STORED ─────────────
  //
  // The rule lives at the SCHEMA — the one door the write route, a direct
  // `parseProviderStore`, and the test seeding helper all re-parse through —
  // so it cannot be bypassed by a caller that skipped a route-level check.
  // Names are canonicalised (`AUTHORIZATION` and `authorization` are the same
  // header on the wire; refusing one and admitting the other would be a
  // one-character bypass) and judged by the single sensitive-key owner, so a
  // name added there is refused here with no edit.
  const headers = ctx.value.headers;
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    const canonical = canonicalHeaderName(name);
    if (isSensitiveKey(canonical)) {
      ctx.issues.push({
        code: "custom",
        input: name,
        path: ["headers", name],
        message:
          `The header "${name}" is a credential-carrying name, and those are not stored on a provider. ` +
          (canonical === "Authorization"
            ? `If this provider answers to a different bearer, save that value as its API key instead — one credential per provider, in one place.`
            : `Remove it, or ask for it under a name the key catalogue does not treat as a secret.`),
      });
      continue;
    }
    // A header VALUE that IS this provider's own key would put the same
    // secret in two places, and the second place does not rotate when the
    // first does. EXACT equality, not a substring — a substring test refuses
    // any short key that happens to appear inside an ordinary value ("k"
    // inside "kept-value"), which is the catalogue over-refusing, not the
    // duplicate-credential misconfiguration this rule exists to catch.
    const key = ctx.value.apiKey;
    if (key !== undefined && value === key) {
      ctx.issues.push({
        code: "custom",
        input: name,
        path: ["headers", name],
        message:
          `The header "${name}" carries this provider's own API key as its value, which stores the same secret twice. ` +
          `The key field already sends it; remove the header.`,
      });
    }
  }
});

/**
 * The whole per-user provider document, exactly as it sits in
 * `user_model_prefs.config_json` (encrypted at rest).
 *
 * `defaultProvider` / `defaultModel` are STORED CHOICES, not resolution-time
 * guesses. When a user saves their first provider the write route records the
 * choice explicitly; nothing infers a default at read time, because an
 * inferred default is a fallback wearing a smaller hat — it would silently
 * move when a provider list changed.
 */
export const PROVIDER_STORE_SCHEMA = z.strictObject({
  providers: z.array(STORED_PROVIDER).default([]),
  defaultProvider: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
}).check((ctx) => {
  // ── AN INCOHERENT DEFAULT PAIR CANNOT BE STORED ─────────────────────────
  //
  // `defaultProvider` and `defaultModel` were two independent fields, and the
  // settings form posts only the second. So the write route resolved the first
  // from whatever was already saved — and the stored document could end up
  // naming provider A beside a model only provider B serves. The UI then
  // badged BOTH as the default, which is two different claims about one fact,
  // and a run resolving by MODEL went to B while everything on screen said A.
  //
  // The pair is a single fact — "this model, at this provider" — so it is
  // validated as one, at the schema, which is the door both the save route and
  // the delete route re-parse their merged document through. A document that
  // cannot answer "which provider serves the default model" consistently is
  // simply not a document this store accepts.
  //
  // Judged ONLY when the named provider is actually present in the same
  // document. A partial request body legitimately mentions a provider it is
  // not itself carrying; it is the MERGED document that has to be coherent,
  // and that one always carries every provider it names.
  const document = ctx.value;
  const { defaultProvider, defaultModel } = document;
  if (defaultProvider === undefined || defaultModel === undefined) return;
  const named = document.providers.find((provider) => provider.id === defaultProvider);
  if (named === undefined) return;
  if (named.models.some((model) => model.id === defaultModel)) return;
  ctx.issues.push({
    code: "custom",
    input: defaultModel,
    path: ["defaultModel"],
    message:
      `The default model "${defaultModel}" is not one of the models "${defaultProvider}" serves, ` +
      `so a run and the settings page would disagree about which provider answers. ` +
      `Choose a model that provider serves, or make its owner the default provider.`,
  });
});

/**
 * THE WRITE SHAPE — the document exactly as it is stored, and the ONLY shape
 * in which the API key is a plain string.
 *
 * Named explicitly rather than being the default meaning of "the store",
 * because the default should be the safe one: everything that merely READS
 * holds a {@link ProviderStore}, and reaching the string form is an act with a
 * name ({@link storedFormOf}) that a reader can search for.
 */
export type ProviderDocument = z.infer<typeof PROVIDER_STORE_SCHEMA>;
export type StoredProvider = z.infer<typeof STORED_PROVIDER>;
export type StoredModel = z.infer<typeof STORED_MODEL>;

/**
 * One saved provider AS A READER HOLDS IT: the key is a call, exactly as it is
 * on a credential, so no serialiser and no logger can find a string to print.
 *
 * `apiKey` absent still means "this provider owes a key" — the same fact
 * `hasApiKey` reports and the same fact the refusals name — so nothing about
 * the incomplete-provider state changes.
 */
export type SavedProvider = Readonly<{
  id: string;
  baseUrl: string;
  models: readonly StoredModel[];
  apiKey?: () => string;
  /**
   * The provider's extra request headers. A CALL, never a field — a header
   * value can be a credential-shaped secret, and a value that is not a
   * property cannot be printed by a serialiser, a spread, or an inspector.
   * Absent means "this provider carries none" (the common case).
   */
  headers?: () => Readonly<Record<string, string>>;
}>;

/** The whole saved document as a reader holds it. */
export type ProviderStore = Readonly<{
  providers: readonly SavedProvider[];
  defaultProvider?: string;
  defaultModel?: string;
}>;

/** The empty document — what a user who has configured nothing has. */
export const EMPTY_PROVIDER_STORE: ProviderStore = Object.freeze({ providers: Object.freeze([]) });

/**
 * MATERIALISE THE KEY BACK INTO A FIELD, for the one caller that must: the
 * write route, which merges the saved document with an incoming edit and hands
 * the result to the schema and then to the database.
 *
 * It exists as a named function rather than as an inline `apiKey?.()` at the
 * merge so there is exactly one place in the process where a stored key becomes
 * a string again, and that place is greppable. Everything else reads
 * {@link SavedProvider} and cannot produce a printable key by accident.
 */
export function storedFormOf(provider: SavedProvider): StoredProvider {
  const key = provider.apiKey?.();
  const headers = provider.headers?.();
  return {
    id: provider.id,
    baseUrl: provider.baseUrl,
    models: provider.models as StoredModel[],
    ...(key !== undefined ? { apiKey: key } : {}),
    ...(headers !== undefined ? { headers: { ...headers } } : {}),
  };
}

// ── The safe projection: what may cross the wire ──────────────────────────

/**
 * A provider as the UI is allowed to see it.
 *
 * There is no `apiKey` field and there is no room for one: the type does not
 * declare it, so a route that tried to widen the response would have to change
 * this declaration, which is a visible edit rather than an accidental spread.
 * `hasApiKey` carries the only fact the UI actually needs — whether this
 * provider is finished — without carrying the secret that answers it.
 */
export type ProviderView = Readonly<{
  id: string;
  baseUrl: string;
  models: readonly StoredModel[];
  hasApiKey: boolean;
  /**
   * The NAMES of the custom headers this provider carries — never the values.
   * A header value can be secret-shaped, so what crosses the wire is the set
   * of names, which is all the settings surface needs to say "2 extra headers
   * saved" and to prefill the editor. The `hasApiKey` pattern, applied to the
   * second credential-shaped field.
   */
  headerNames: readonly string[];
}>;

/** Every saved provider, projected safely. Never includes a key. */
export function providerViews(store: ProviderStore): readonly ProviderView[] {
  return store.providers.map((provider) => ({
    id: provider.id,
    baseUrl: provider.baseUrl,
    models: provider.models,
    hasApiKey: provider.apiKey !== undefined,
    headerNames: Object.freeze(Object.keys(provider.headers?.() ?? {}).sort()),
  }));
}

// ── Reading the store ─────────────────────────────────────────────────────

/**
 * Parse a stored blob into a provider document.
 *
 * A blob that does not parse is reported as EMPTY rather than thrown, and the
 * distinction matters: an unreadable document and an absent one leave the user
 * in the same place — nothing usable is configured — and the guided state is
 * the honest response to both. Throwing here would give a user whose row was
 * written by an older shape a stack trace instead of a way forward.
 */
export function parseProviderStore(raw: unknown): ProviderStore {
  if (raw === null || raw === undefined) return EMPTY_PROVIDER_STORE;
  const parsed = PROVIDER_STORE_SCHEMA.safeParse(raw);
  if (!parsed.success) return EMPTY_PROVIDER_STORE;
  return readableStore(parsed.data);
}

/**
 * The ONE conversion from the stored document to the shape readers hold — and
 * therefore the one place a plain key stops being a string. Every read of the
 * document goes through `parseProviderStore`, and `parseProviderStore` goes
 * through here, so there is no reader that could be handed the printable form.
 */
function readableStore(document: ProviderDocument): ProviderStore {
  return Object.freeze({
    providers: Object.freeze(document.providers.map(readableProvider)),
    ...(document.defaultProvider !== undefined ? { defaultProvider: document.defaultProvider } : {}),
    ...(document.defaultModel !== undefined ? { defaultModel: document.defaultModel } : {}),
  });
}

function readableProvider(provider: StoredProvider): SavedProvider {
  const key = provider.apiKey;
  const headers = provider.headers;
  return Object.freeze({
    id: provider.id,
    baseUrl: provider.baseUrl,
    models: Object.freeze([...provider.models]),
    // Closed over, never stored as a property — the same construction the
    // credential uses, for the same reason.
    ...(key !== undefined ? { apiKey: (): string => key } : {}),
    // And the headers the same way: a value a serialiser cannot find cannot
    // be printed by one. The record itself is frozen so the returned view
    // shares no mutable state with the parsed document.
    ...(headers !== undefined
      ? { headers: (): Readonly<Record<string, string>> => Object.freeze({ ...headers }) }
      : {}),
  });
}

/** The provider document saved for one user. The ONLY read of it. */
export async function loadProviderStore(
  db: AsyncDbClient,
  userId: string,
): Promise<ProviderStore> {
  return parseProviderStore(await db.getUserModelPrefs(userId));
}

// ── The credential: the only thing the LLM client accepts ─────────────────

/**
 * The brand. A real module-private symbol, never exported, so no other module
 * can name the key and therefore none can construct a value of this type. This
 * is the same door pattern the source-view reader uses, pointed at credentials
 * instead of at file text.
 *
 * A `declare`d brand would be erased at run time and any object literal would
 * satisfy the interface, which would make the whole guarantee cosmetic.
 */
const PROVIDER_CREDENTIAL_BRAND: unique symbol = Symbol("db-provider-credential");

/**
 * The credentials THIS MODULE minted, tagged by capability. A `WeakMap`, so a credential that goes
 * out of scope stays collectable. The insertion lives beside the freeze in the
 * mint, and `admitMintedCredential` is the consult the bridge makes before a
 * credential becomes a client — the runtime arm the compile-time brand
 * cannot be (a spread copies the brand; it cannot copy membership).
 */
const MINTED_CREDENTIALS = new WeakMap<object, "inference" | "discovery">();

/**
 * THE CHOKE-POINT CONSULT — refuse any brand-shaped object the mint below
 * never constructed. `server/llm-bridge.ts` calls this at its one
 * client-construction door; a caller holding a genuine credential passes
 * untouched.
 */
export function admitMintedCredential(credential: ProviderCredential): ProviderCredential {
  if (
    typeof credential !== "object" ||
    credential === null ||
    MINTED_CREDENTIALS.get(credential) !== "inference"
  ) {
    throw new ForgedProviderCredentialError();
  }
  return credential;
}

/**
 * Everything needed to talk to a provider, obtainable only from the database.
 *
 * Not assignable from an object literal, a parsed JSON file, or a test
 * fixture — see the brand above. The key is a method, not a field, so the
 * value is safe to log, serialise, spread and interpolate.
 */
export interface ProviderCredential {
  readonly [PROVIDER_CREDENTIAL_BRAND]: "db-provider-credential";
  /** Which saved provider answered. */
  readonly providerId: string;
  /** Where its API lives. */
  readonly baseUrl: string;
  /** The model this credential was resolved FOR — never a fallback model. */
  readonly modelId: string;
  /**
   * The stored per-model facts resolved WITH this credential — the
   * settings room's per-model rows: the context window the compose-time
   * estimate and the trim budget honour, and the request defaults a run
   * applies when its caller set none. The record is REQUIRED rather than
   * optional, so a credential spelled without it does not compile; an
   * ABSENT field means "let the provider decide" — the same honesty the
   * stored schema uses, so a model that declared nothing answers an empty
   * record, which is a real answer.
   */
  readonly model: Readonly<{
    readonly contextWindow?: number;
    readonly maxTokens?: number;
    readonly temperature?: number;
  }>;
  /**
   * THE DESTINATION RULE, stamped at the mint from the owner (the outbound
   * door's `privateAddressesAllowedFor`): may this provider's requests reach
   * a loopback/private address? One answer for the run, the stream and the
   * connection test (secc-design H2: the test route and runs used to reach
   * any address a non-admin saved).
   */
  readonly allowPrivateAddress: boolean;
  /**
   * The secret. A call, so nothing reaches it by enumeration.
   */
  apiKey(): string;
  /**
   * The provider's extra request headers. REQUIRED rather than optional, so
   * a credential cannot be spelled from a shape that forgot the field — a
   * provider with none answers an empty record, which is a real answer rather
   * than an absence. A call, for the same reason `apiKey` is one: header
   * values can be secret-shaped, and a method is not reachable by a
   * serialiser. The engine merges these over its base set
   * (`shared/llm/client.ts`), so a name colliding with a built-in header
   * would replace it — which is why the schema refuses credential-carrying
   * names rather than letting one silently override `Authorization`.
   */
  headers(): Readonly<Record<string, string>>;
}

/**
 * The single mint. Private on purpose: `resolveProviderCredential` is the only
 * caller, and it only ever runs against a document read from the database.
 */
function mintCredential(
  provider: SavedProvider,
  apiKey: string,
  modelId: string,
  owner: ProviderOwner,
): ProviderCredential {
  // The key and the header values are the USER's (providers are per user):
  // the client holds them for every call it makes (its held list, masked at
  // the mint and in its diagnostics) and they are NOT registered in the
  // process-wide registry, which holds only the harness's own secrets — a
  // user's value there masked every other user's text, and enough of them
  // switched registration off (CRED-F2/F3).
  const headers = Object.freeze({ ...(provider.headers?.() ?? {}) });
  // FROZEN, because it was not and that was measurable: `Object.assign(cred,
  // { baseUrl: "https://evil.example", apiKey: () => "ATTACKER-KEY" })`
  // compiled AND succeeded, redirecting the genuine credential the bridge was
  // about to use — every property was `writable: true, configurable: true`.
  // Freezing turns that assignment into a `TypeError` in strict mode (which
  // every module here is, being ESM) rather than a silent redirect. It does
  // NOT stop a SPREAD, which copies the brand and builds a new object; see
  // the header for what a brand does and does not buy.
  // THE PER-MODEL FACTS RIDE THE SAME MINT. The credential is resolved FOR a
  // model, and the stored row for that model is the one place its settings
  // live — so they are carried here, at the birth of every credential, and
  // no consumer has to re-look the store up (or could silently disagree
  // about which stored row answers). Frozen like the credential itself, so
  // a later mutation of the parsed store cannot reach a live run.
  const storedModel = provider.models.find((model) => model.id === modelId);
  const modelFacts = Object.freeze({
    ...(storedModel?.contextWindow !== undefined ? { contextWindow: storedModel.contextWindow } : {}),
    ...(storedModel?.maxTokens !== undefined ? { maxTokens: storedModel.maxTokens } : {}),
    ...(storedModel?.temperature !== undefined ? { temperature: storedModel.temperature } : {}),
  });
  const credential: ProviderCredential = {
    [PROVIDER_CREDENTIAL_BRAND]: "db-provider-credential",
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    modelId,
    model: modelFacts,
    allowPrivateAddress: privateAddressesAllowedFor(owner),
    apiKey: () => apiKey,
    headers: () => headers,
  };
  const frozen = Object.freeze(credential);
  MINTED_CREDENTIALS.set(frozen, "inference");
  return frozen;
}

/** Who a credential is minted for — the facts its destination rule is decided from. */
export type ProviderOwner = Readonly<{ isAdmin: boolean }>;

export interface ProviderEndpointCredential {
  readonly [PROVIDER_CREDENTIAL_BRAND]: "draft-provider-endpoint";
  readonly providerId: string;
  readonly baseUrl: string;
  /** The same destination rule as the inference credential's (stamped here). */
  readonly allowPrivateAddress: boolean;
  apiKey(): string;
  headers(): Readonly<Record<string, string>>;
}

export function admitEndpointCredential(credential: ProviderEndpointCredential): ProviderEndpointCredential {
  if (typeof credential !== "object" || credential === null || MINTED_CREDENTIALS.get(credential) !== "discovery") {
    throw new ForgedProviderCredentialError();
  }
  return credential;
}

/** The discovery body's one validator (the wire shape is `ProviderDiscoveryInput`):
 * the route parses with it at the trust boundary, so the resolver below only
 * ever sees a typed draft. */
export const PROVIDER_DISCOVERY_INPUT = z.strictObject({
  savedProviderId: STORED_PROVIDER.shape.id.optional(),
  baseUrl: STORED_PROVIDER.shape.baseUrl,
  apiKey: STORED_PROVIDER.shape.apiKey,
  headers: STORED_PROVIDER.shape.headers,
});

/** Saved secrets may be reused only for the explicitly selected, unchanged
 * endpoint. Draft credentials never enter the persisted inference mint. */
export function credentialForDiscovery(store: ProviderStore, draft: z.output<typeof PROVIDER_DISCOVERY_INPUT>, owner: ProviderOwner): ProviderEndpointCredential {
  const saved = draft.savedProviderId === undefined ? undefined : store.providers.find(p => p.id === draft.savedProviderId);
  if (draft.savedProviderId !== undefined && saved === undefined) throw new ValidationError("This saved provider is no longer available.", "provider_unknown");
  const unchanged = saved?.baseUrl.replace(/\/+$/, "") === draft.baseUrl.replace(/\/+$/, "");
  const apiKey = draft.apiKey ?? (unchanged ? saved?.apiKey?.() : undefined);
  if (apiKey === undefined) throw new ValidationError("Enter an API key for this address before finding models.", "provider_key_missing");
  // Reuse the stored header validation, including duplicate credential values.
  const provider = STORED_PROVIDER.parse({ id: draft.savedProviderId ?? "provider draft", baseUrl: draft.baseUrl, apiKey,
    headers: draft.headers ?? (unchanged ? saved?.headers?.() : undefined) });
  const headers = Object.freeze({ ...(provider.headers ?? {}) }); // held per call like the mint's (see mintCredential)
  const credential: ProviderEndpointCredential = Object.freeze({
    [PROVIDER_CREDENTIAL_BRAND]: "draft-provider-endpoint" as const,
    providerId: provider.id, baseUrl: provider.baseUrl, allowPrivateAddress: privateAddressesAllowedFor(owner), apiKey: () => apiKey, headers: () => headers,
  });
  MINTED_CREDENTIALS.set(credential, "discovery");
  return credential;
}

/** The provider that serves `modelId`, or null. */
function providerServing(store: ProviderStore, modelId: string): SavedProvider | undefined {
  return store.providers.find((provider) => provider.models.some((model) => model.id === modelId));
}

/**
 * The model a run should use when the request and the chat both named none.
 *
 * Reads the STORED default and nothing else. There is deliberately no "if
 * there is only one model, use it" branch: that is a resolution-time guess,
 * and it would move the moment the user added a second model — the exact
 * silent drift a fallback source produces.
 */
function storedDefaultModel(store: ProviderStore): string | undefined {
  return store.defaultModel;
}

/**
 * Resolve the credential for a run, or REFUSE with the remedy.
 *
 * `requestedModelId` is what the caller already decided (the request body, or
 * the chat's saved model). Null means "nothing was chosen", and the stored
 * default answers it — or, if the user never chose one, the refusal does.
 *
 * Every failure path here names the specific thing that is missing and ends
 * with {@link PROVIDER_SETUP_REMEDY}. None of them returns a degraded value:
 * the three distinguishable states are a working credential, a refusal naming
 * a missing provider, and a refusal naming a missing key.
 */
export function resolveProviderCredential(
  store: ProviderStore,
  requestedModelId: string | null,
  owner: ProviderOwner,
): ProviderCredential {
  if (store.providers.length === 0) {
    throw new ProviderNotConfiguredError(
      `No model provider is saved for this account, so there is nothing to send this run to. ${PROVIDER_SETUP_REMEDY}`,
    );
  }

  const modelId = requestedModelId ?? storedDefaultModel(store);
  if (modelId === undefined) {
    throw new ProviderNotConfiguredError(
      `No model was chosen for this run and no default model is saved. ` +
      `Pick a model for this conversation, or set a default one in Settings.`,
      "model_not_chosen",
    );
  }

  const provider = providerServing(store, modelId);
  if (provider === undefined) {
    throw new ProviderNotConfiguredError(
      `The model "${modelId}" is not served by any provider you have saved. ` +
      `Either pick a model one of your providers serves, or add "${modelId}" to a provider. ${PROVIDER_SETUP_REMEDY}`,
      "model_not_configured",
    );
  }

  if (provider.apiKey === undefined) {
    throw new ProviderNotConfiguredError(
      `The provider "${provider.id}" has no API key saved, so its requests would be rejected before they reached the model. ` +
      `Open Settings and give "${provider.id}" its API key.`,
      "provider_key_missing",
    );
  }

  return mintCredential(provider, provider.apiKey(), modelId, owner);
}

/**
 * The context window the ACTIVE model declares, for surfaces that compose a
 * request WITHOUT minting a credential — the compose preview must work even
 * while the provider still owes a key, and minting refuses in that state.
 *
 * Resolves the model exactly the way {@link resolveProviderCredential} does
 * (a null id means "the stored default answers"), reads the same stored
 * document, and answers `undefined` when the model is not saved or declares
 * no window — the caller then falls back to the harness-wide limit, never a
 * guess.
 */
export function storedContextWindowFor(
  store: ProviderStore,
  requestedModelId: string | null,
): number | undefined {
  const modelId = requestedModelId ?? storedDefaultModel(store);
  if (modelId === undefined) return undefined;
  const provider = providerServing(store, modelId);
  return provider?.models.find((model) => model.id === modelId)?.contextWindow;
}

/**
 * The credential for one named provider, for a connection test.
 *
 * Separate from {@link resolveProviderCredential} because the QUESTION is
 * different: a test asks "does THIS provider work", so a provider serving no
 * models is a refusal rather than a lookup miss.
 *
 * ── IT USED TO TEST A MODEL RUNS WOULD NEVER USE ──────────────────────────
 *
 * The model was unconditionally `provider.models[0]`. The button then reported
 * "Answered as <that model>", which is a real answer from a real endpoint about
 * a model the user may never send anything to — and the case the button exists
 * for is precisely a mistake in the setup, where naming the wrong model makes
 * the reassurance false. A green test on a model nobody uses is the shape of
 * "correct and unplugged", in a diagnostic.
 *
 * So it prefers the model the RUN PATH would pick — the user's stored default,
 * when this provider is the one that serves it — and falls back to the first
 * listed model only when this provider serves no part of that choice, which is
 * the honest best available. Either way the route returns `credential.modelId`,
 * so the surface names the model that was actually asked rather than assuming.
 */
export function credentialForProvider(
  store: ProviderStore,
  providerId: string,
  owner: ProviderOwner,
): ProviderCredential {
  const provider = store.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    throw new ValidationError(
      `No provider named "${providerId}" is saved for this account.`,
      "provider_unknown",
    );
  }
  if (provider.apiKey === undefined) {
    throw new ProviderNotConfiguredError(
      `The provider "${provider.id}" has no API key saved, so there is nothing to test with. ` +
      `Open Settings and give "${provider.id}" its API key.`,
      "provider_key_missing",
    );
  }
  // The model a RUN would use, when this provider is the one that serves it.
  // Read through the same accessor the run path reads, so the two cannot come
  // to disagree about what "the default model" means.
  const storedDefault = storedDefaultModel(store);
  const modelToTest = provider.models.find((model) => model.id === storedDefault)
    ?? provider.models[0];
  if (modelToTest === undefined) {
    throw new ProviderNotConfiguredError(
      `The provider "${provider.id}" lists no models, so there is nothing to ask it for. ` +
      `Open Settings and add at least one model name to "${provider.id}".`,
      "provider_models_missing",
    );
  }
  return mintCredential(provider, provider.apiKey(), modelToTest.id, owner);
}
