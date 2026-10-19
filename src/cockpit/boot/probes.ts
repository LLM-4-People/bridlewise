/**
 * REGISTRATION probe orchestration (§10) — every line is a REAL probe with
 * a REAL measured duration. Nothing here is theater: each line's `ms` is
 * `performance.now()` around an actual request to the actual endpoint, and
 * a subsystem that cannot answer prints its absence as its own line
 * ("index · no project yet"), never as silence and never as a spinner.
 *
 * Probe set:
 *   session — GET /api/auth/status via client.checkAuthStatus (the auth
 *             flow survives; its FORM does not — §13). This is the FIRST
 *             request of the boot: it also answers "is the server
 *             reachable", so the old `/api/health` leg that asked the same
 *             question one round trip earlier is gone (§1 L4).
 *   schema  — GET /api/schema/ui via client.getUiSchema (auth-gated).
 *   index   — GET /api/projects (auth-gated; measured project count). The
 *             `/api/intelligence/map` half is OFF this path: it wrote no
 *             store, filled no cache, gated nothing, and existed to print a
 *             file count — a whole serial leg for a flourish (§1 L4).
 *   conversation — printed only when a project exists: the KEPT selection
 *             (persisted currentProjectId/currentChatId, restored into the
 *             stores at module load) is validated against the server's real
 *             lists and the last conversation's history is loaded BEFORE
 *             the reveal (§10: the last conversation restores at its kept
 *             position; a stale kept id clears to an honest "no
 *             conversation open").
 *
 * ── The shape of the boot (§1 L4) ──
 *
 * It was SEVEN strictly serial legs, measured. Every one of them waited for
 * the previous response before its own request left, and only two of those
 * waits were real dependencies. It is now:
 *
 *   wave 1   auth
 *   wave 2   schema ∥ projects ∥ chats(persisted project) ∥ history(persisted chat)
 *
 * The last two are OPTIMISTIC: their keys are already in storage before the
 * first request leaves, so they do not need the list that validates them —
 * the validation happens when the list lands, in parallel, and a speculative
 * answer about an id that turned out to be stale is discarded rather than
 * shown (`AheadRead` carries the key it asked about, for exactly that check).
 *
 * The critical batch for the one-reveal (§10.3) is: session + schema.
 * `index` is awaited too (a line may never appear AFTER the reveal — that
 * would be a late mount) but its failure is an absence line, not a block.
 *
 * Imports here obey the cockpit import law (tests/cockpit/
 * cockpit-no-legacy-imports.test.ts): client data functions + the broker +
 * src/state only. No src/lib UI, no old tokens.
 */

import {
  checkAuthStatus,
  getUiSchema,
  listChats,
  listProjects,
  loadChatHistory,
} from "../../client.ts";
import { ClientError } from "../../data/errors.ts";
import type { AuthStatus } from "../../state/auth.ts";
import type { AnswerStateId, OutcomeStateId } from "../response/grammar.ts";
import {
  currentProjectId,
  selectProject,
  type ProjectSummary,
} from "../../state/projects.ts";
import { currentChatId, selectChat } from "../../state/chats.ts";
// The boot cost is ALREADY measured here (the waves' own total). The
// telemetry owner only forwards the number — one fact, one measurer — into
// the browser's back-channel so the ledger holds the page's own boot time.
import { noteBootMs } from "../../state/telemetry.ts";

/**
 * The probe vocabulary DERIVES from the grammar's two axes rather than
 * restating its own: a probe line is either a measured outcome (`ok` — the
 * outcome axis) or an answer about the surface (`absent` — nothing there;
 * `failed` — the read broke). The names agreed with grammar.ts by
 * coincidence once; now a renamed grammar state is a compile error here,
 * not a silent mismatch on the first screen anyone sees.
 */
export type ProbeState = Extract<OutcomeStateId, "ok"> | Extract<AnswerStateId, "absent" | "failed">;

export type ProbeLine = Readonly<{
  id: string;
  /** Engraved label, plain words. */
  label: string;
  /** Measured detail ("1,318 files", "you · ada", "signed out"). */
  detail: string;
  /** Measured wall duration of the probe, ms (integer). */
  ms: number;
  state: ProbeState;
}>;

export type AuthGate = "signed-out" | "setup" | "offline";

export type RegistrationEvents = Readonly<{
  /** A probe completed — append its line to the column. */
  onLine: (line: ProbeLine) => void;
  /** The session probe says a passphrase is needed (or the server is
   * unreachable). The column pauses at the signature line. */
  onAuthGate: (gate: AuthGate) => void;
  /** All probes done — the critical batch is complete; reveal may fire. */
  onComplete: (summary: Readonly<{ totalMs: number; username: string }>) => void;
}>;

const nf = new Intl.NumberFormat("en-US");

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** What the boot knows about a conversation before its history is read. */
type ChatLike = Readonly<{ id: string; title: string }>;

/**
 * A read FIRED AHEAD of the leg that consumes it, carrying the id it was
 * keyed on. The key travels with the promise because a speculative read is
 * only usable if it asked about the thing that turned out to be current —
 * an answer about a stale id is an answer to a different question, and using
 * it would be exactly the fabrication this product exists to refuse.
 */
type AheadRead<T> = Readonly<{ key: string; read: Promise<Measured<T>> }> | null;

type Measured<T> = { value: T | null; ms: number; error: unknown };

/** Re-raise what an ahead read swallowed, so the caller's own catch sees the
 * same failure it would have seen had it issued the request itself. */
async function unwrap<T>(read: Promise<Measured<T>>): Promise<T> {
  const settled = await read;
  if (settled.value === null) {
    throw settled.error ?? new ClientError("boot_read_failed", "the read did not answer");
  }
  return settled.value;
}

async function measure<T>(fn: () => Promise<T>): Promise<Measured<T>> {
  const t0 = now();
  try {
    const value = await fn();
    return { value, ms: Math.max(1, Math.round(now() - t0)), error: null };
  } catch (error) {
    return { value: null, ms: Math.max(1, Math.round(now() - t0)), error };
  }
}

/**
 * The registration controller. `start()` probes reach + session; if the
 * session needs a passphrase it fires `onAuthGate` and stops — the caller
 * signs in through client.ts (submitLogin/submitRegister) and then calls
 * `afterAuth()` to continue the SAME column into session boot (§10.2).
 */
export function createRegistration(events: RegistrationEvents): Readonly<{
  start: () => Promise<void>;
  afterAuth: (username: string) => Promise<void>;
}> {
  const t0 = now();
  let username = "";

  /**
   * ONE WAVE, NOT FOUR (§1 L4).
   *
   * Everything here needs the session COOKIE and nothing else — no leg reads
   * a field of another leg's response before issuing its own request. They
   * were serial only because they were written as four consecutive `await`s
   * in one function body, which is an accident of syntax rather than a
   * dependency. Measured: boot was 7 strictly serial legs; the real
   * dependency graph needs 4 waves; and because the project and chat ids are
   * ALREADY PERSISTED (sessionStorage, seeded from localStorage, restored
   * into the atoms at module load — before this function is even called),
   * firing the two id-keyed reads optimistically collapses it to ~2.
   *
   * "Optimistic" is precise here, not hopeful:
   *   - a persisted id that is stale answers 404/403; that IS the validation,
   *     just arriving in parallel with the list instead of after it, and
   *     `restoreKeptConversation` still refuses to keep a pointer the real
   *     list does not contain;
   *   - `loadChatHistory` is already gated on `currentChatId` still being
   *     the chat it asked for, so a superseded optimistic load cannot write;
   *   - every line is still appended BEFORE the reveal, so the one-reveal law
   *     and the zero-late-mount guard are untouched. What changed is when the
   *     requests leave, not when the column is drawn.
   */
  async function sessionProbes(): Promise<void> {
    const schemaAhead = measure(() => getUiSchema());
    const projectsAhead = measure(() => listProjects());
    // The two reads whose key we already know. `listChats` is keyed by the
    // persisted project; the history by the persisted chat. Both are read
    // here, once, so a later `selectProject` cannot change which id was
    // speculated on.
    const keptProjectId = currentProjectId.get();
    const keptChatId = currentChatId.get();
    const chatsAhead: AheadRead<readonly ChatLike[]> =
      keptProjectId === null
        ? null
        : { key: keptProjectId, read: measure(() => listChats(keptProjectId)) };
    const historyAhead: AheadRead<unknown> =
      keptChatId === null
        ? null
        : { key: keptChatId, read: measure(() => loadChatHistory(keptChatId)) };

    // schema — the UI manifest, the first auth-gated readiness fact.
    const schema = await schemaAhead;
    if (schema.value !== null) {
      events.onLine({
        id: "schema",
        label: "schema",
        detail: "ready",
        ms: schema.ms,
        state: "ok",
      });
    } else {
      events.onLine({
        id: "schema",
        label: "schema",
        detail: "not available",
        ms: schema.ms,
        state: "failed",
      });
    }

    // index — the project index. What it measures is the projects read, and
    // that is now ALL it measures.
    //
    // It used to await `/api/intelligence/map` for the most recently updated
    // project as well, and print its file count. That read writes no store,
    // fills no cache and gates nothing: it existed to print one decorative
    // line, and it sat on the critical path of every boot to do it — and it
    // is not even free, because a cold index answers `MapNotReadyError` after
    // paying the latency (§1 L4). A whole serial leg for a flourish. The line
    // stays, because a registration line must be a real probe and this one
    // is; what it says is now the thing that was actually measured.
    const projects = await projectsAhead;
    if (projects.value === null) {
      events.onLine({
        id: "index",
        label: "index",
        detail: "not available",
        ms: projects.ms,
        state: "failed",
      });
    } else if (projects.value.length === 0) {
      events.onLine({
        id: "index",
        label: "index",
        detail: "no project yet",
        ms: projects.ms,
        state: "absent",
      });
    } else {
      const count = projects.value.length;
      events.onLine({
        id: "index",
        label: "index",
        detail: `${nf.format(count)} project${count === 1 ? "" : "s"}`,
        ms: projects.ms,
        state: "ok",
      });
    }

    // conversation — the §10 restore, completed BEFORE onComplete so the
    // restored place/flow appear IN the reveal frame, never after it. Its two
    // reads were issued at the top of this wave; this awaits them.
    if (projects.value !== null && projects.value.length > 0) {
      const projectList = projects.value;
      const restore = await measure(() =>
        restoreKeptConversation(projectList, chatsAhead, historyAhead),
      );
      const outcome: RestoreOutcome =
        restore.value ?? { detail: "restore failed", state: "failed" };
      events.onLine({
        id: "conversation",
        label: "conversation",
        detail: outcome.detail,
        ms: restore.ms,
        state: outcome.state,
      });
    }

    // The boot's own measured total, forwarded to the telemetry channel.
    // This is the SAME number the reveal fires with — no second clock, no
    // second measurement, one fact with one measurer.
    const totalMs = Math.round(now() - t0);
    noteBootMs(totalMs);
    events.onComplete({ totalMs, username });
  }

  return {
    async start(): Promise<void> {
      // NO `/api/health` LEG. It was the first of seven serial legs and it
      // gated exactly one thing — "is the server reachable" — which the very
      // next request answers anyway: `checkAuthStatus` returns
      // `{ offline: true }` on the same network failure, and the branch below
      // already prints `session · unreachable` and gates on it. A probe that
      // asks a question the next probe must ask again is a round trip bought
      // for nothing, on the path where round trips cost most (§1 L4). Its
      // response was never read: `{ status, harnessReady }` went straight to
      // the floor.
      const session = await measure(() => checkAuthStatus());
      const auth: AuthStatus | null = session.value;
      if (auth === null || auth.offline) {
        events.onLine({
          id: "session",
          label: "session",
          detail: "unreachable",
          ms: session.ms,
          state: "failed",
        });
        events.onAuthGate("offline");
        return;
      }
      if (auth.authenticated) {
        username = auth.username;
        events.onLine({
          id: "session",
          label: "session",
          detail: `you · ${auth.username}`,
          ms: session.ms,
          state: "ok",
        });
        await sessionProbes();
        return;
      }
      if (auth.setupRequired) {
        events.onLine({
          id: "session",
          label: "session",
          detail: "no owner yet",
          ms: session.ms,
          state: "absent",
        });
        events.onAuthGate("setup");
        return;
      }
      events.onLine({
        id: "session",
        label: "session",
        detail: "signed out",
        ms: session.ms,
        state: "absent",
      });
      events.onAuthGate("signed-out");
    },

    async afterAuth(user: string): Promise<void> {
      username = user;
      await sessionProbes();
    },
  };
}

type RestoreOutcome = Readonly<{ detail: string; state: ProbeState }>;

/**
 * §10 restore — validate the persisted selection against the server's real
 * lists and load the kept conversation's history. NEVER throws: every
 * outcome is a plain-words line detail. Honesty rules:
 *  - a persisted project id not in the real list falls back to the most
 *    recently updated project (the same "newest" the index probe measures);
 *  - a kept chat id that no longer exists CLEARS (a stale pointer would
 *    render a conversation that is not there);
 *  - an unreachable chat list keeps the kept id (clearing on a transient
 *    failure would erase the user's place) and says it is unverified.
 */
async function restoreKeptConversation(
  list: readonly ProjectSummary[],
  chatsAhead: AheadRead<readonly ChatLike[]> = null,
  historyAhead: AheadRead<unknown> = null,
): Promise<RestoreOutcome> {
  const persisted = currentProjectId.get();
  const persistedValid = persisted !== null && list.some((p) => p.id === persisted);
  const projectId = persistedValid
    ? persisted
    : [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!.id;
  if (!persistedValid) selectProject(projectId);

  const keptChatId = currentChatId.get();
  let chats: readonly ChatLike[];
  try {
    // The optimistic read counts ONLY if it asked about the project we ended
    // up on. A persisted id that turned out to be stale sent its request to
    // the wrong list; using that answer would restore against a project the
    // user does not have open, which is worse than the round trip it saves.
    chats =
      chatsAhead !== null && chatsAhead.key === projectId
        ? await unwrap(chatsAhead.read)
        : await listChats(projectId);
  } catch (error) {
    return keptChatId === null
      ? { detail: "none kept — no conversation open", state: "absent" }
      : {
          detail: `kept id not verified — ${error instanceof Error ? error.message : String(error)}`,
          state: "failed",
        };
  }
  if (keptChatId === null) {
    return { detail: "none kept — no conversation open", state: "absent" };
  }
  const kept = chats.find((c) => c.id === keptChatId);
  if (kept === undefined) {
    selectChat(null);
    return { detail: "kept conversation no longer exists", state: "absent" };
  }
  const title = kept.title.length > 0 ? kept.title : "untitled";
  try {
    // Same rule as the chat list: the ahead read counts only if it asked
    // about the conversation the list just confirmed. `loadChatHistory`
    // deduplicates by chat id anyway, so calling it here when the optimistic
    // read is still in flight JOINS that read rather than issuing a second
    // one — the boot cannot double-fire the history the way the Flow's
    // self-heal effect once did.
    if (historyAhead !== null && historyAhead.key === kept.id) {
      await unwrap(historyAhead.read);
    } else {
      await loadChatHistory(kept.id);
    }
    return { detail: `restored · ${title}`, state: "ok" };
  } catch {
    return { detail: `${title} · history not loaded`, state: "failed" };
  }
}

