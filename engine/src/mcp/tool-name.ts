/**
 * MCP tool naming — the ONE place where a (server id, MCP tool name) pair
 * becomes a harness tool name.
 *
 * The harness name is what the model sees in the `tools` array, what the
 * system prompt lists, what the gate, the breaker and the per-user toggles
 * key on, and what `tool_calls` rows persist. It must therefore be a legal
 * Responses function name (`^[A-Za-z0-9_-]{1,128}$`, the spec grammar owned
 * by `shared/llm/responses.ts`), and it must be minted exactly once: every
 * consumer that needs the name asks this module, and every consumer that
 * needs the pair BACK asks the registry that minted it (a lookup), never a
 * string parser.
 *
 * Shape: `mcp__<serverId>__<toolName>`. A server id is restricted to
 * `[A-Za-z0-9-]` (no `_`, no `.`), so the first `__` after the prefix always
 * ends the server id and two servers can never mint the same head. An MCP
 * tool name may legally contain `.` (and servers send other characters too),
 * so when the plain form is not a legal function name — or is too long — the
 * tool part is sanitised and a short digest of the RAW pair is appended, which
 * keeps the result deterministic.
 *
 * THE PLAIN AND DIGEST SPACES ARE DISJOINT. Every digest name ends in
 * `_<8 lowercase hex>`, so a tool whose own name already ends that way is
 * minted in the digest form too: otherwise `foo_bar_70bdbd8f` (plain) and
 * `foo.bar` (sanitised + its digest) of one server minted the SAME name —
 * constructible, since the digest is public (secb-security SECB-V-5). Two
 * digest names can still meet only through a 32-bit digest collision between
 * two tools of ONE server (the head carries the server id), which the
 * registry refuses as `mcp_tool_name_collision` for that server alone.
 *
 * THE OUTPUT IS PERSISTED. Per-user tool switches and the replayed call
 * history store these names, and they store ONLY the name — not the raw
 * pair — so a stored digest name cannot be recomputed by SQL: a change to
 * what this module mints (the digest, the sanitiser, the id grammar)
 * orphans the stored switches and history of every tool whose name changes,
 * and has to be weighed as exactly that (or ship with a migration that first
 * stores the raw pair). Migration 19 keeps its own frozen copy of the rule it
 * applied, and the golden tests (`test/mcp/tool-name.test.ts`,
 * `tests/unit/mcp-tool-name-migration.test.ts`) pin both.
 */

import { InputError } from "../kernel/errors.ts";
import { sha256 } from "../kernel/integrity.ts";
import { FUNCTION_NAME_PATTERN, RESPONSES_FUNCTION_NAME_MAX_CHARACTERS } from "../shared/llm/responses.ts";

/** Every harness name minted for an MCP tool starts with this. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";
const DELIMITER = "__";
/** Hex characters of the raw-pair digest a sanitised name carries. */
const DIGEST_HEX_CHARACTERS = 8;
const DIGEST_SUFFIX_CHARACTERS = 1 + DIGEST_HEX_CHARACTERS;

/**
 * A server id: letters, digits and single inner hyphens. No `_` and no `.`,
 * which is what makes the `__` delimiter unambiguous. The ONE pattern — the
 * config document schema, the runtime validator and the settings write door
 * all import it.
 */
export const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

/**
 * The longest server id that still leaves room for at least one tool
 * character and a digest inside the spec's 128-character function name.
 * Derived from the grammar, never typed: a longer id could not name any tool.
 */
export const MCP_SERVER_ID_MAX_CHARACTERS =
  RESPONSES_FUNCTION_NAME_MAX_CHARACTERS - MCP_TOOL_NAME_PREFIX.length - DELIMITER.length - DIGEST_SUFFIX_CHARACTERS - 1;

/** True when `serverId` can own MCP tool names. */
export function isMcpServerId(serverId: string): boolean {
  return serverId.length <= MCP_SERVER_ID_MAX_CHARACTERS && MCP_SERVER_ID_PATTERN.test(serverId);
}

/** The head every tool name of one server starts with (`mcp__<id>__`). */
export function mcpToolNameHead(serverId: string): string {
  if (!isMcpServerId(serverId)) {
    throw new InputError(`MCP server id '${serverId}' cannot name tools (letters, digits and inner hyphens, at most ${MCP_SERVER_ID_MAX_CHARACTERS} characters)`, "mcp_config_invalid");
  }
  return `${MCP_TOOL_NAME_PREFIX}${serverId}${DELIMITER}`;
}

/** The shape every digest-tagged name ends with — never left to a plain name. */
const DIGEST_TAG_SHAPE = new RegExp(`_[0-9a-f]{${DIGEST_HEX_CHARACTERS}}$`, "u");

/** Deterministic, spec-legal harness name for one MCP tool; distinct pairs of one server get distinct names. */
export function mcpToolName(serverId: string, toolName: string): string {
  const head = mcpToolNameHead(serverId);
  const plain = `${head}${toolName}`;
  if (FUNCTION_NAME_PATTERN.test(plain) && !DIGEST_TAG_SHAPE.test(toolName)) return plain;
  const tag = `_${sha256(`${serverId}\u0000${toolName}`).slice(0, DIGEST_HEX_CHARACTERS)}`;
  const room = RESPONSES_FUNCTION_NAME_MAX_CHARACTERS - head.length - tag.length;
  return `${head}${toolName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, room)}${tag}`;
}

/**
 * The owner's predicate for "this name is in the MCP namespace". It answers
 * only the namespace question (a built-in can never start with the prefix —
 * `tests/prevention/tool-name-spec.test.ts` holds that); which server and
 * which tool a name means is answered by the registry's one reverse lookup.
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_NAME_PREFIX);
}
