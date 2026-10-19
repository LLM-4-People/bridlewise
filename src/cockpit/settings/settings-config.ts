/**
 * @config-owner — THE SETTINGS INDEX (spec §9.3 values).
 *
 * The single owner of the settings surfaces' tunable constants, following the
 * cockpit pattern (switch-config.ts, custody-config.ts, instruments-config.ts):
 * numbers live here, behavior lives in the modules that import them.
 */

/**
 * The narrowest room that holds the CATEGORY RAIL and the settings beside it
 * (px, measured on the room's own box — not the viewport).
 *
 * This is NOT the shell's fold: the fold (1100) decides where the horizon's
 * room rail folds away, while this number decides where the split row grid
 * actually fits — the five row tracks at their token minimums plus their
 * gutters, beside a rail at its `--index-rail-max` ceiling, inside the
 * scroll gutters, measured ≈1330px. Firing the split at the fold squeezed
 * every track to its floor while nowrap cells kept their full width, so
 * label and value text painted over the neighbouring column. Below this
 * width the map rides above the settings (the narrow arrangement), which
 * is the same arrangement the fold already teaches.
 */
export const SETTINGS_SPLIT_MIN_PX = 1400;

/**
 * How many settings a category must hold before the index offers to fold it.
 *
 * Nothing is folded by default and nothing is EVER folded by the system:
 * "the user should not fear missing out" is a rule about who decides, so
 * folding is a gesture, never a default, and the fold state is remembered per
 * category for the session. This bound only decides where the fold GRIP is
 * worth rendering — under it, the grip would cost more pixels than the rows
 * it could hide.
 */
export const CATEGORY_FOLD_MIN_ROWS = 4;

/**
 * Pointer travel (px) per numeral step while drag-scrubbing a number
 * setting. A gesture constant, not a visual token — lives here with the
 * other settings-surface numbers.
 */
export const NUMERAL_SCRUB_PX_PER_STEP = 6;

// ── The tool-server list's settle follow (the registry's hot rebuild) ────────

/**
 * How often the tool-server list re-reads while the MCP registry's settle is
 * in flight (ms).
 *
 * A write verb (add, edit, remove) kicks the registry's hot rebuild, and a
 * status read served before the new registry publishes answers the
 * unmeasured "stopped" for every row — the honest in-flight snapshot, never
 * a settled claim. The follow re-reads at this cadence until a row is
 * measured, so a just-added server's face ends at the wire's settled answer
 * (the rebuild is measured at ~2s with the shipped server set) without a
 * reload. Sub-second on purpose: the face should flip within a beat of the
 * wire, not a poll cycle after it.
 */
export const MCP_SETTLE_FOLLOW_POLL_MS = 300;

/**
 * The wall-clock bound on that follow (ms). Past it the follow stops without
 * inventing anything: rows that still read "stopped" mean the registry
 * genuinely has no published measurement for them (a rebuild wedged past any
 * connect timeout the config could declare), and the wire's own word stands
 * — never an eternal reader.
 */
export const MCP_SETTLE_FOLLOW_MAX_MS = 60_000;

/** Keep large remote model catalogs bounded in the native chooser. Filter and
 * pages retain access to every returned ID without mounting the whole list. */
export const PROVIDER_DISCOVERY_PAGE_SIZE = 24;
