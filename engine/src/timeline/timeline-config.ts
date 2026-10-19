/** Timeline operational defaults — canonical owner for timeline-domain configurable values.
 * Also owns the timeline-store inline caps (`MAXIMUM_DOCUMENT_BYTES`,
 * `MAXIMUM_DOCUMENTS`, `MAXIMUM_EDGES`, `DEFAULT_SQLITE_CACHE_SIZE`) which
 * were scattered inline literals in timeline-store.ts. */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;
export const QUERY_BATCH_SIZE = 500;
export const DEFAULT_MAXIMUM_DOCUMENT_BYTES = 1_048_576;
export const DEFAULT_MAXIMUM_DOCUMENTS = 32;
export const DEFAULT_MAXIMUM_EDGES = 32;
export const DEFAULT_SQLITE_CACHE_SIZE = -65_536;

/**
 * Byte budget reserved for the truncation envelope's OWN JSON overhead when a
 * document is fitted to `maxDocumentBytes` — the fixed cost of
 * `{"truncated":true,"fullPayloadDigest":"<64 hex>","fullPayloadBytes":<n>, …}`
 * plus escape widening on the preview. It is a SEED, not a guarantee: the
 * fitting loop re-measures the stored bytes and shrinks the preview until the
 * whole document actually fits, so an envelope that costs more than this seed
 * is corrected, never overflowed. It is a protocol constant of the wrapper
 * format (the envelope's shape), not an operator knob — an operator cannot
 * make the envelope cheaper by declaring it so — which is why it lives beside
 * the document-format defaults rather than in the config file.
 */
export const TRUNCATION_ENVELOPE_OVERHEAD_BYTES = 256;

/**
 * SQLite `PRAGMA synchronous` for the ledger — the DURABILITY CHOICE, made
 * here rather than inherited.
 *
 * It was `"FULL"`, hardcoded inline in timeline-store.ts with no config key:
 * a default nobody chose. Measured on this machine, on real ext4 (NOT
 * `os.tmpdir()`, which is tmpfs where fsync is a no-op and every durability
 * comparison is meaningless):
 *
 *     synchronous=FULL     5.615 ms per recorded append (p50)
 *     synchronous=NORMAL   0.107 ms
 *     synchronous=OFF      0.094 ms
 *
 * FULL is therefore 52× NORMAL, and the entire difference is fsync: the
 * recording itself is 0.17% of an append (AsyncLocalStorage 1µs, chain hash
 * 9µs measured). NORMAL is not a weakening of recording — every byte is still
 * written, the chain hash is still computed, the registry is still closed and
 * the ledger is still append-only. It changes only WHEN the bytes are flushed.
 *
 * A returned append acknowledges a committed SQLite event; it does not prove
 * a power-loss-safe flush. NORMAL can lose recent commits on OS/power failure.
 * A local chain verifies retained links, but cannot detect a removed suffix
 * without a separately trusted head. Checkpoints reduce exposure; their timer
 * is scheduling policy, not a hard real-time durability bound.
 */
export const DEFAULT_TIMELINE_SYNCHRONOUS = "NORMAL";

/**
 * Requested checkpoint interval. Scheduling delays, busy writers and checkpoint
 * failures can extend the flush interval, so this is not a maximum loss window.
 * Zero disables the timer; SQLite's size-triggered checkpoint remains separate.
 */
export const DEFAULT_DURABILITY_WINDOW_MS = 1_000;
