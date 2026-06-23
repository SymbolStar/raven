import { Hono } from "hono"
import { z } from "zod"
import type { Database } from "bun:sqlite"

import {
  compileProvider,
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
  updateProviderAuthStyle,
  updateProviderModelsSupport,
} from "./../db/providers"
import { cacheProviders } from "./../lib/utils"
import { getProxyUrl } from "./../lib/socks5-bridge"
import { state } from "./../lib/state"
import { buildAuthHeaders } from "./../lib/auth-headers"
import type { CreateProviderInput, ProviderAuthStyle, ProviderFormat, UpdateProviderInput, ProviderRecord } from "./../db/providers"

// ===========================================================================
// Validation schemas
// ===========================================================================

const createProviderSchema = z.object({
  name: z.string().min(1).max(100),
  base_url: z.string().url(),
  format: z.enum(["openai", "anthropic"]),
  api_key: z.string().min(1),
  model_patterns: z.array(z.string()).min(1),
  is_enabled: z.boolean().optional().default(true),
  supports_reasoning: z.boolean().optional().default(false),
  auth_style: z.enum(["bearer", "x-api-key"]).nullable().optional(),
})

const updateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  base_url: z.string().url().optional(),
  format: z.enum(["openai", "anthropic"]).optional(),
  api_key: z.string().min(1).optional(),
  model_patterns: z.array(z.string()).min(1).optional(),
  is_enabled: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  auth_style: z.enum(["bearer", "x-api-key"]).nullable().optional(),
})

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Check if any of the given model patterns conflict with:
 * 1. Copilot models (from state.models) - exact patterns only
 * 2. Existing providers (excluding the provider being updated) - exact patterns only
 *
 * NOTE: Glob patterns (e.g., "glm-*") are allowed to overlap with exact patterns.
 * The routing logic uses exact-first matching, so globs serve as fallbacks.
 *
 * Returns array of conflicting model names.
 */
function checkModelConflicts(
  db: Database,
  patterns: string[],
  excludeProviderId: string | null = null,
): string[] {
  const conflicts: string[] = []

  // Check exact patterns against Copilot models
  if (state.models?.data) {
    for (const pattern of patterns) {
      // Skip glob patterns - they're allowed as fallbacks
      if (pattern.includes("*")) continue

      // Exact pattern: check for conflict
      const conflicting = state.models.data.find((m) => m.id === pattern)
      if (conflicting && !conflicts.includes(pattern)) {
        conflicts.push(pattern)
      }
    }
  }

  // Check exact patterns against other providers
  const allProviders = db
    .query("SELECT id, model_patterns, enabled FROM providers")
    .all() as Array<{ id: string; model_patterns: string; enabled: number }>

  for (const other of allProviders) {
    if (excludeProviderId && other.id === excludeProviderId) continue

    try {
      const otherPatterns: string[] = JSON.parse(other.model_patterns)
      for (const pattern of patterns) {
        // Skip glob patterns - they're allowed as fallbacks
        if (pattern.includes("*")) continue

        for (const otherPattern of otherPatterns) {
          // Skip glob patterns - they're allowed as fallbacks
          if (otherPattern.includes("*")) continue

          // Exact-to-exact conflict
          if (pattern === otherPattern && !conflicts.includes(pattern)) {
            conflicts.push(pattern)
          }
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return conflicts
}

/**
 * Probe upstream to check if /v1/models endpoint is supported.
 * Updates the database with the result.
 *
 * For anthropic-format providers, also auto-detects which auth header style
 * the upstream accepts (Bearer vs x-api-key) by trying each, and persists
 * the winning style via updateProviderAuthStyle.
 */
async function probeModelsEndpoint(
  db: Database,
  providerId: string,
  baseUrl: string,
  apiKey: string,
  provider?: ProviderRecord,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`
  const compiled = provider ? compileProvider(provider) : null
  const proxyUrl = compiled ? getProxyUrl(compiled, state) : undefined
  const format: ProviderFormat = provider?.format ?? "openai"

  const tryAuth = async (style: ProviderAuthStyle): Promise<Response | null> => {
    try {
      return await fetch(url, {
        headers: buildAuthHeaders(apiKey, style),
        signal: AbortSignal.timeout(5000),
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      } as RequestInit)
    } catch {
      return null
    }
  }

  // OpenAI-format always uses Bearer — no detection needed.
  if (format === "openai") {
    const res = await tryAuth("bearer")
    const supports = !!res && res.ok
    try {
      updateProviderModelsSupport(db, providerId, supports)
      cacheProviders(db)
    } catch {
      // DB may be closed in tests, ignore
    }
    return supports
  }

  // Anthropic-format: try x-api-key first (Anthropic standard), then Bearer.
  // Record which style succeeded so the messages path can pick the right header.
  let detected: ProviderAuthStyle | null = null
  let modelsOk = false

  const a = await tryAuth("x-api-key")
  if (a && a.ok) {
    detected = "x-api-key"
    modelsOk = true
  } else {
    const b = await tryAuth("bearer")
    if (b && b.ok) {
      detected = "bearer"
      modelsOk = true
    } else {
      // Neither succeeded as 2xx. Distinguish "auth wrong style" (401/403)
      // from genuine "endpoint missing" (404) — a 401 on x-api-key plus a
      // non-401 on bearer (or vice versa) tells us the style even when the
      // models endpoint isn't usable.
      const aStatus = a?.status ?? 0
      const bStatus = b?.status ?? 0
      const aRejected = aStatus === 401 || aStatus === 403
      const bRejected = bStatus === 401 || bStatus === 403
      if (aRejected && !bRejected && bStatus > 0) detected = "bearer"
      else if (bRejected && !aRejected && aStatus > 0) detected = "x-api-key"
    }
  }

  try {
    updateProviderModelsSupport(db, providerId, modelsOk)
    if (detected !== null) updateProviderAuthStyle(db, providerId, detected)
    // Refresh state so messages/ path picks up the new auth_style without
    // needing another CRUD edit or restart.
    cacheProviders(db)
  } catch {
    // DB may be closed in tests, ignore
  }
  return modelsOk
}

// ===========================================================================
// Route factory
// ===========================================================================

export function createUpstreamsRoute(db: Database): Hono {
  const app = new Hono()

  // GET /upstreams — list all providers
  app.get("/upstreams", (c) => {
    const providers = listProviders(db)
    return c.json(providers)
  })

  // GET /upstreams/:id — get one provider
  app.get("/upstreams/:id", (c) => {
    const id = c.req.param("id")
    const provider = getProvider(db, id)
    if (!provider) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }
    return c.json(provider)
  })

  // POST /upstreams — create provider
  app.post("/upstreams", async (c) => {
    // Block if Copilot models aren't loaded (conflict detection would be incomplete)
    if (!state.models?.data) {
      return c.json(
        {
          error: {
            message: "Cannot create provider: Copilot models not loaded. Conflict detection against Copilot models is unavailable.",
            type: "service_unavailable",
          },
        },
        503,
      )
    }

    let input: CreateProviderInput
    try {
      const parsed = createProviderSchema.parse(await c.req.json())
      input = Object.fromEntries(
        Object.entries(parsed).filter(([_, v]) => v !== undefined),
      ) as unknown as CreateProviderInput
    } catch {
      return c.json({ error: { message: "Invalid input" } }, 400)
    }

    // Check for model conflicts
    const conflicts = checkModelConflicts(db, input.model_patterns)
    if (conflicts.length > 0) {
      return c.json(
        {
          error: {
            message: `Model conflicts with existing models: ${conflicts.join(", ")}`,
            type: "model_conflict",
            conflicts,
          },
        },
        409,
      )
    }

    const provider = createProvider(db, input)

    // Refresh state so new provider is immediately routable
    cacheProviders(db)

    // Probe models endpoint in background (don't block response)
    // Note: we don't need to refresh cache after probe since supports_models_endpoint
    // is only used by the health check endpoint, not the routing engine
    const newRow = db
      .query("SELECT * FROM providers WHERE id = $id")
      .get({ $id: provider.id }) as ProviderRecord | null
    if (newRow) {
      probeModelsEndpoint(db, provider.id, input.base_url, input.api_key, newRow)
    }

    return c.json(provider, 201)
  })

  // PUT /upstreams/:id — update provider
  app.put("/upstreams/:id", async (c) => {
    const id = c.req.param("id")
    const existing = getProvider(db, id)
    if (!existing) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    let input: UpdateProviderInput
    try {
      const parsed = updateProviderSchema.parse(await c.req.json())
      // Filter out undefined values for exactOptionalPropertyTypes compatibility
      input = Object.fromEntries(
        Object.entries(parsed).filter(([_, v]) => v !== undefined),
      ) as UpdateProviderInput
    } catch {
      return c.json({ error: { message: "Invalid input" } }, 400)
    }

    // Block if updating model_patterns and Copilot models aren't loaded
    if (input.model_patterns !== undefined && !state.models?.data) {
      return c.json(
        {
          error: {
            message: "Cannot update model patterns: Copilot models not loaded. Conflict detection against Copilot models is unavailable.",
            type: "service_unavailable",
          },
        },
        503,
      )
    }

    // Check for model conflicts (exclude current provider)
    const conflicts = checkModelConflicts(
      db,
      input.model_patterns ?? existing.model_patterns,
      id,
    )
    if (conflicts.length > 0) {
      return c.json(
        {
          error: {
            message: `Model conflicts with existing models: ${conflicts.join(", ")}`,
            type: "model_conflict",
            conflicts,
          },
        },
        409,
      )
    }

    // Reset auth_style if any of base_url/api_key/format changed and the
    // caller didn't explicitly override it — the stored detection no longer
    // applies to the new endpoint/credential/protocol.
    const existingRow = db
      .query("SELECT * FROM providers WHERE id = $id")
      .get({ $id: id }) as ProviderRecord | null
    const credentialChanged = existingRow !== null && (
      (input.base_url !== undefined && input.base_url !== existingRow.base_url) ||
      (input.api_key !== undefined && input.api_key !== existingRow.api_key) ||
      (input.format !== undefined && input.format !== existingRow.format)
    )
    if (credentialChanged && input.auth_style === undefined) {
      updateProviderAuthStyle(db, id, null)
    }

    const updated = updateProvider(db, id, input)
    if (!updated) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    // Refresh state
    cacheProviders(db)

    // Re-probe if base_url or api_key changed
    if (input.base_url !== undefined || input.api_key !== undefined) {
      // Get full record to access api_key and proxy settings
      const row = db
        .query("SELECT * FROM providers WHERE id = $id")
        .get({ $id: id }) as ProviderRecord | null
      if (row) {
        probeModelsEndpoint(db, id, row.base_url, row.api_key, row)
      }
    }

    return c.json(updated)
  })

  // DELETE /upstreams/:id — delete provider
  app.delete("/upstreams/:id", (c) => {
    const id = c.req.param("id")
    const existing = getProvider(db, id)
    if (!existing) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    deleteProvider(db, id)

    // Refresh state
    cacheProviders(db)

    return c.json({ success: true })
  })

  // GET /upstreams/:id/models — health check + list models from upstream
  app.get("/upstreams/:id/models", async (c) => {
    const id = c.req.param("id")

    // Get full provider record (with api_key) from DB
    const row = db
      .query("SELECT * FROM providers WHERE id = $id")
      .get({ $id: id }) as ProviderRecord | null

    if (!row) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    // Build models endpoint URL
    const baseUrl = row.base_url.replace(/\/+$/, "")
    const modelsUrl = `${baseUrl}/v1/models`

    try {
      const compiled = compileProvider(row)
      const proxyUrl = compiled ? getProxyUrl(compiled, state) : undefined
      let firstError: unknown = null
      const tryAuth = async (style: ProviderAuthStyle): Promise<Response | null> => {
        try {
          return await fetch(modelsUrl, {
            headers: buildAuthHeaders(row.api_key, style),
            signal: AbortSignal.timeout(10000),
            ...(proxyUrl ? { proxy: proxyUrl } : {}),
          } as RequestInit)
        } catch (err) {
          if (firstError === null) firstError = err
          return null
        }
      }

      // Determine attempt order.
       // - OpenAI runtime only sends Bearer (custom-openai.ts), so health
       //   check must NOT mark provider healthy via x-api-key — that would
       //   mislead the dashboard.
       // - Anthropic providers: honor stored auth_style if present, else try
       //   x-api-key first (Anthropic standard) with Bearer fallback for
       //   Manifest-style forks.
      const order: ProviderAuthStyle[] =
        row.format === "openai"
          ? ["bearer"]
          : row.auth_style === "bearer"
            ? ["bearer", "x-api-key"]
            : row.auth_style === "x-api-key"
              ? ["x-api-key", "bearer"]
              : ["x-api-key", "bearer"]

      let res: Response | null = null
      let detected: ProviderAuthStyle | null = null
      for (const style of order) {
        const r = await tryAuth(style)
        if (r && r.ok) {
          res = r
          detected = style
          break
        }
        // Keep last response for error reporting if none succeed
        if (r) res = r
      }

      // No response at all — treat as connection failure (test contract).
      if (!res && firstError !== null) {
        const message = firstError instanceof Error ? firstError.message : "Unknown error"
        updateProviderModelsSupport(db, id, false)
        cacheProviders(db)
        return c.json(
          {
            error: {
              message: `Failed to connect: ${message}`,
              type: "connection_error",
            },
            healthy: false,
            supports_models_endpoint: false,
          },
          502,
        )
      }

      if (!res || !res.ok) {
        const text = res ? await res.text().catch(() => "") : ""
        const status = res?.status ?? 0
        updateProviderModelsSupport(db, id, false)
        cacheProviders(db)
        return c.json(
          {
            error: {
              message: `Upstream returned ${status}: ${text.slice(0, 200)}`,
              type: "upstream_error",
            },
            healthy: false,
            supports_models_endpoint: false,
          },
          502,
        )
      }

      const data = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> }
      const models = data.data ?? []

      // Update DB: models endpoint supported, persist detected auth style
      updateProviderModelsSupport(db, id, true)
      if (detected !== null && row.format === "anthropic") {
        updateProviderAuthStyle(db, id, detected)
      }
      // Refresh runtime cache so messages/ uses the new auth_style immediately.
      cacheProviders(db)

      // Group models by owned_by
      const grouped: Record<string, string[]> = {}
      for (const model of models) {
        const owner = model.owned_by ?? "unknown"
        if (!grouped[owner]) grouped[owner] = []
        grouped[owner].push(model.id)
      }

      // Sort models within each group
      for (const owner of Object.keys(grouped)) {
        grouped[owner]!.sort()
      }

      return c.json({
        healthy: true,
        total: models.length,
        models: grouped,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      // Update DB: models endpoint not supported (connection error)
      updateProviderModelsSupport(db, id, false)
      cacheProviders(db)
      return c.json(
        {
          error: {
            message: `Failed to connect: ${message}`,
            type: "connection_error",
          },
          healthy: false,
          supports_models_endpoint: false,
        },
        502,
      )
    }
  })

  return app
}
