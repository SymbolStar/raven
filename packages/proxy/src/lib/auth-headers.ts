/**
 * Header builder + fetch wrapper for anthropic-format upstream `/v1/models`
 * probes and runtime calls. Keeps a single source of truth for the auth-style
 * fallback policy:
 *   - openai providers always use Bearer.
 *   - anthropic with stored auth_style: use that style only.
 *   - anthropic with auth_style=null (unknown): try x-api-key first, then
 *     Bearer. Mirrors CustomAnthropicClient's dual-header fallback so the
 *     /v1/models probe and the messages path agree on which providers are
 *     reachable.
 */

import type { CompiledProvider } from "../db/providers"

export type AuthStyle = "bearer" | "x-api-key"

export function buildAuthHeaders(
  apiKey: string,
  style: AuthStyle,
): Record<string, string> {
  if (style === "bearer") {
    return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
  }
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  }
}

/**
 * Decide the ordered list of auth styles to try for a `/v1/models` request,
 * given the provider's format and any previously detected style.
 */
export function authStyleAttempts(
  format: CompiledProvider["format"],
  stored: AuthStyle | null | undefined,
): AuthStyle[] {
  if (format === "openai") return ["bearer"]
  if (stored === "bearer") return ["bearer"]
  if (stored === "x-api-key") return ["x-api-key"]
  return ["x-api-key", "bearer"]
}
