/**
 * Model providers — the HTTP surface over the user's saved providers.
 *
 * THE DATABASE IS THE ONLY SOURCE. This route used to project two config
 * files — the harness config for the provider list and a local operator
 * config for the base URL — and merge the user's saved providers on top
 * of them. Both reads are gone. What a user has is what they saved; what they
 * have not saved does not exist. `server/providers.ts` owns the shape, the
 * parsing and the refusal, and this file is a door onto it.
 *
 * WHY ZERO PROVIDERS IS A 200 AND NOT A 503. It used to be a 503 `unavailable`
 * whose message named a file path the user had never heard of. That is three
 * defects in one: it reports a user-fixable state as a server outage, it tells
 * a client to retry something retrying cannot fix, and it teaches the user
 * about the internals of a lookup. Zero providers is now an ordinary, honest
 * answer — an empty list, `setupRequired: true`, and the remedy in plain words
 * — which is what lets the UI render a setup surface instead of an error.
 *
 * NO API KEY EVER LEAVES HERE. The response type is `ProviderView`, which has
 * no key field to fill in; the only fact about a key that crosses the wire is
 * whether one exists.
 *
 * Routes:
 *   GET    /api/models                             — saved providers + defaults
 *   GET    /api/models/prefs                       — the same, for settings
 *   PUT    /api/models/prefs                       — add or edit a provider
 *   DELETE /api/models/providers/:providerId       — remove a provider
 *   POST   /api/models/providers/:providerId/test  — try the saved credential
 */

import type { Router } from "../router/router.ts";
import { guarded } from "../kernel/canonical.ts";
import { sendJson } from "../router/router.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { ValidationError } from "../kernel/errors.ts";
import { discoverProviderModels, resetProviderClients, testProviderConnection } from "../llm/llm-bridge.ts";
import {
  PROVIDER_DISCOVERY_INPUT,
  PROVIDER_SETUP_REMEDY,
  PROVIDER_STORE_SCHEMA,
  credentialForProvider,
  credentialForDiscovery,
  loadProviderStore,
  parseProviderStore,
  providerViews,
  storedFormOf,
  type ProviderDocument,
  type ProviderStore,
  type ProviderView,
  type SavedProvider,
  type StoredProvider,
} from "../llm/providers.ts";

// ── Response types ──

type ModelsResponse = Readonly<{
  readonly providers: readonly ProviderView[];
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
  /** True when the user has saved nothing — the UI renders guided setup. */
  readonly setupRequired: boolean;
  /**
   * What to do about it, in the SAME words a refused run shows. Sent even when
   * setup is not required, because the settings page states the same thing to
   * a user adding their second provider.
   */
  readonly setupRemedy: string;
}>;

function project(store: ProviderStore): ModelsResponse {
  const providers = providerViews(store);
  return {
    providers,
    defaultProvider: store.defaultProvider ?? null,
    defaultModel: store.defaultModel ?? null,
    setupRequired: providers.length === 0,
    setupRemedy: PROVIDER_SETUP_REMEDY,
  };
}

// ── Write input ──

/**
 * What a save may contain — the stored shape EXACTLY, the same schema object
 * the store declares rather than a second one that happens to agree today. A
 * merge therefore cannot produce a document the input would have rejected.
 *
 * `apiKey` is accepted here and this is the ONLY way a key enters the system.
 * It is never echoed back: every read path projects through `ProviderView`.
 */
const MODEL_PREFS_INPUT = PROVIDER_STORE_SCHEMA;

/**
 * MERGE BY IDENTITY — the single owner of "how two provider lists combine".
 *
 * Providers are keyed by `id`. An entry in `incoming` REPLACES the entry with
 * the same id in `base`; an entry in `base` that `incoming` does not mention
 * is PRESERVED. Order is base-first, then the genuinely new entries, so an
 * existing list does not reshuffle when one entry is edited.
 *
 * WHY: a whole-array overwrite here is silent data loss. The settings form
 * posts a single-provider array (it only knows about the provider being
 * added), so a whole-blob write deleted every provider the user had saved
 * before, with no warning and no way back.
 *
 * EDITING WITHOUT RETYPING THE KEY. A replacement that omits `apiKey` keeps
 * the key the stored entry already had. Without that, correcting a base URL
 * would silently unset the credential — the user would fix one field and
 * break another, and the only symptom would be a refused run some time later.
 * Clearing a key is still possible; it is done by removing the provider,
 * which is an explicit act with its own door.
 */
function mergeProvidersById(
  base: readonly SavedProvider[],
  incoming: readonly StoredProvider[],
): readonly StoredProvider[] {
  const byId = new Map<string, StoredProvider>();
  // THE ONE PLACE A SAVED KEY BECOMES A STRING AGAIN. The base comes from the
  // read shape, where the key is a call; the value written back to the database
  // must carry it as a field, so it is materialised here, deliberately, through
  // the named conversion rather than by an inline `?.()` a reader would skim.
  for (const provider of base) byId.set(provider.id, storedFormOf(provider));
  for (const provider of incoming) {
    const previous = byId.get(provider.id);
    const carriedKey = provider.apiKey ?? previous?.apiKey;
    // The headers are carried the same way the key is: an edit that does not
    // resend them keeps the saved set, so correcting an address cannot
    // silently unset the headers any more than it can the credential.
    const carriedHeaders = provider.headers ?? previous?.headers;
    byId.set(provider.id, {
      ...provider,
      ...(carriedKey !== undefined ? { apiKey: carriedKey } : {}),
      ...(carriedHeaders !== undefined ? { headers: carriedHeaders } : {}),
    });
  }
  return [...byId.values()];
}

/**
 * The defaults after a save.
 *
 * A user who has just saved their FIRST provider has not been asked which one
 * is the default, and asking would be a question with one possible answer. So
 * the choice is RECORDED here, at write time, into the same document every
 * reader trusts — a stored decision, not a read-time guess, and it stays put
 * when a second provider arrives.
 *
 * An explicit choice in the request always wins; an existing stored choice is
 * left alone.
 */
function resolveDefaults(
  providers: readonly StoredProvider[],
  incoming: ProviderDocument,
  existing: ProviderStore,
): Readonly<{ defaultProvider?: string; defaultModel?: string }> {
  // ── THE MODEL IS THE CHOICE; THE PROVIDER IS DERIVED FROM IT ─────────────
  //
  // These used to be resolved independently — the provider from
  // `incoming ?? existing ?? providers[0]`, the model from
  // `incoming ?? existing ?? thatProvider.models[0]` — and the settings form
  // posts only the model. So a user who picked a model served by their SECOND
  // provider stored that model beside the FIRST provider's id, and the UI
  // badged both as the default while a run went to neither of the two things
  // the screen claimed.
  //
  // A model id already names its provider: exactly one saved provider serves
  // it. Deriving the provider from the model therefore removes the
  // disagreement instead of validating around it, and it means the missing form
  // field stops being a defect — there was never a second question to ask.
  // An explicit `defaultProvider` in the request still wins, for a caller that
  // genuinely means to set both, and the schema refuses the pair if they
  // contradict each other.
  const first = providers[0];
  const defaultModel = incoming.defaultModel ?? existing.defaultModel ?? first?.models[0]?.id;
  const servingModel = defaultModel === undefined
    ? undefined
    : providers.find((provider) => provider.models.some((model) => model.id === defaultModel));
  const defaultProvider = incoming.defaultProvider ?? servingModel?.id ?? existing.defaultProvider ?? first?.id;
  return {
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
}

/**
 * The defaults after a REMOVAL.
 *
 * A default pointing at a provider that no longer exists is a dangling
 * reference, and the run path would refuse on it with a message about a model
 * that "no provider serves" — technically true and useless. So removing a
 * provider drops any default it owned and re-points at whatever remains. When
 * nothing remains, nothing is defaulted and the user is back in guided setup.
 */
function defaultsAfterRemoval(
  remaining: readonly StoredProvider[],
  existing: ProviderStore,
): Readonly<{ defaultProvider?: string; defaultModel?: string }> {
  const keptProvider = remaining.find((provider) => provider.id === existing.defaultProvider)
    ?? remaining[0];
  if (keptProvider === undefined) return {};
  const keptModel = keptProvider.models.some((model) => model.id === existing.defaultModel)
    ? existing.defaultModel
    : keptProvider.models[0]?.id;
  return {
    defaultProvider: keptProvider.id,
    ...(keptModel !== undefined ? { defaultModel: keptModel } : {}),
  };
}

/** The one path a provider name arrives on, validated once. */
function providerIdParam(params: Readonly<Record<string, string>>): string {
  const providerId = params["providerId"];
  if (providerId === undefined || providerId.length === 0) {
    throw new ValidationError("A provider name is required.", "provider_id_missing");
  }
  return providerId;
}

// ── Route registration ──

export function registerModelRoutes(router: Router, db: AsyncDbClient): void {
  // GET /api/models — everything the picker and the settings page render.
  router.get("/api/models", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    sendJson(ctx.res, project(await loadProviderStore(db, user.userId)) satisfies ModelsResponse);
  });

  // GET /api/models/prefs — the saved document, projected safely.
  router.get("/api/models/prefs", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    sendJson(ctx.res, { prefs: project(await loadProviderStore(db, user.userId)) });
  });

  // Discovery never writes preferences. Disconnect aborts the one request.
  // The body is validated HERE, at the trust boundary: a ZodError propagates
  // and the router maps it to 400 `validation_failed` with the issue.
  router.post("/api/models/discover", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const draft = PROVIDER_DISCOVERY_INPUT.parse(ctx.body);
    const credential = credentialForDiscovery(await loadProviderStore(db, user.userId), draft, user);
    const abort = new AbortController();
    const cancel = guarded("models.discover.cancel", () => abort.abort());
    ctx.res.on("close", cancel);
    try {
      const result = await discoverProviderModels(credential, abort.signal);
      if (!ctx.res.destroyed) sendJson(ctx.res, result);
    } finally { ctx.res.off("close", cancel); }
  });

  // PUT /api/models/prefs — add a provider, or edit one that exists.
  //
  // The read-merge-write is SERIALISED PER USER by the facade (a transaction
  // cannot cross the worker-thread boundary), so two concurrent saves cannot
  // lose each other's update.
  router.put("/api/models/prefs", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    // Let ZodError propagate — the router maps it to 400 `validation_failed`
    // with the SPECIFIC issue, which is more use to a user than a generic
    // "invalid payload".
    const incoming = MODEL_PREFS_INPUT.parse(ctx.body);
    const merged = await db.updateUserModelPrefs(user.userId, (existingRaw) => {
      const existing = parseProviderStore(existingRaw);
      const providers = mergeProvidersById(existing.providers, incoming.providers);
      // Re-validate the MERGED document, not just the request: the stored
      // blob is what every later read trusts, so it must satisfy the same
      // contract the request did.
      return MODEL_PREFS_INPUT.parse({
        providers,
        ...resolveDefaults(providers, incoming, existing),
      });
    });
    // A cached client was built from the OLD base URL and the OLD key. Keeping
    // it would make a correction appear to save and change nothing — the
    // failure a user cannot debug, because everything on screen says it worked.
    resetProviderClients();
    sendJson(ctx.res, { ok: true, prefs: project(parseProviderStore(merged)) });
  });

  // DELETE /api/models/providers/:providerId — remove a provider.
  //
  // There was no way to do this at all: the merge is add-and-replace, so a
  // provider saved by mistake — a typo in its name, an endpoint that no longer
  // exists — stayed in the picker permanently.
  router.delete("/api/models/providers/:providerId", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const providerId = providerIdParam(ctx.params);
    let removed = false;
    const next = await db.updateUserModelPrefs(user.userId, (existingRaw) => {
      const existing = parseProviderStore(existingRaw);
      // Materialised through the named conversion, exactly as the merge does:
      // the providers that SURVIVE a removal are being written back, so each
      // one has to carry its key as a field again. Filtering the read shape
      // straight into the schema would hand it `apiKey: () => …` and every
      // surviving provider would silently lose its credential on any delete.
      const remaining = existing.providers
        .filter((provider) => provider.id !== providerId)
        .map(storedFormOf);
      removed = remaining.length !== existing.providers.length;
      return MODEL_PREFS_INPUT.parse({
        providers: remaining,
        ...defaultsAfterRemoval(remaining, existing),
      });
    });
    // Removing something that was never there is REPORTED, not silently
    // treated as success: a client that deleted the wrong name deserves to
    // learn that, and "it worked" for a no-op is how a stale UI stays stale.
    if (!removed) {
      throw new ValidationError(
        `No provider named "${providerId}" is saved for this account.`,
        "provider_unknown",
      );
    }
    // A live client holding the deleted provider's key would outlive the
    // record it came from.
    resetProviderClients();
    sendJson(ctx.res, { ok: true, prefs: project(parseProviderStore(next)) });
  });

  // POST /api/models/providers/:providerId/test — does this actually work?
  //
  // The gap this fills: until now the first proof that a key was mistyped was
  // a run failing after the user had written a prompt and waited. The probe is
  // a REAL request through the real client to the real endpoint — not a URL
  // shape check — so a wrong key, a wrong address and an unreachable host are
  // all distinguishable, before anything depends on the answer.
  //
  // The response carries the provider's own failure text, which is the useful
  // part; it cannot carry the key: the client HOLDS the key for its own calls
  // and masks it in every diagnostic it produces (the held list), and this
  // route never holds it. The address is held to the credential's destination
  // rule, the same one discovery and runs follow.
  router.post("/api/models/providers/:providerId/test", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const providerId = providerIdParam(ctx.params);
    const store = await loadProviderStore(db, user.userId);
    // A missing provider, a missing key and a provider with no models each
    // refuse with their own message, from the single owner.
    const credential = credentialForProvider(store, providerId, user);
    const result = await testProviderConnection(credential);
    sendJson(ctx.res, { providerId, modelId: credential.modelId, ...result });
  });
}

// Exported for the write-door tests, which assert that what the route accepts
// and what the store declares are the SAME object rather than two schemas that
// happen to agree today.
export { MODEL_PREFS_INPUT };
export type { ModelsResponse };
