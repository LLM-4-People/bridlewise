/**
 * Outbound validation helpers — the trust-boundary enforcement layer.
 *
 * The server validates request bodies against canonical Zod schemas before
 * dispatch. A validation failure throws a typed ValidationError carrying an
 * `invalid_*` code, which the router maps to a 400.
 */

import type { z } from "zod";
import { ValidationError, BadRequestError } from "../kernel/errors.ts";

export function assertValidBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  code: string,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Invalid request body: ${issues}`, code);
  }
  return result.data;
}

/**
 * Extract + validate the `path` query parameter (the project root for
 * path-based routes). Throws `BadRequestError` (→ 400) when the param is
 * missing/empty or contains a null byte. The single owner of the
 * "project path query param" extraction (previously each of
 * intelligence/awareness/quality/git-ops/file-tree duplicated this exact
 * helper; no duplicate logic).
 */
export function requirePathQuery(ctx: { query: URLSearchParams }): string {
  const path = ctx.query.get("path");
  if (path === null || path.length === 0) {
    throw new BadRequestError("Project path is required", "missing_path");
  }
  if (path.includes("\0")) {
    throw new BadRequestError("Path contains invalid characters", "invalid_path");
  }
  return path;
}
