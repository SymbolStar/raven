import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { Hono } from "hono"
import { Database } from "bun:sqlite"

import { createUpstreamsRoute } from "../../src/routes/upstreams"
import { createProvider, getEnabledProviders, getProvider, initProviders } from "../../src/db/providers"
import { state } from "../../src/lib/state"

// ===========================================================================
// Helpers
// ============================================================================

function makeApp(db: Database): Hono {
  const app = new Hono()
  app.route("/api", createUpstreamsRoute(db))
  return app
}

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  return new Request(`http://localhost${path}`, init)
}

// ===========================================================================
// Setup / teardown
// ============================================================================

let db: Database
let fetchSpy: ReturnType<typeof vi.spyOn>
const savedModels = state.models
const savedProviders = state.providers

beforeEach(() => {
  db = new Database(":memory:")
  initProviders(db)
  // Set state.models to avoid 503 errors
  state.models = { object: "list" as const, data: [] }
  // Clear providers to avoid polluting other tests
  state.providers = []
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
})

afterEach(() => {
  fetchSpy.mockRestore()
  db.close()
  state.models = savedModels
  state.providers = savedProviders
})

// ===========================================================================
// Tests
// ============================================================================

describe("upstreams API", () => {
  describe("GET /api/upstreams", () => {
    test("returns empty array when no providers exist", async () => {
      const app = makeApp(db)
      const res = await app.request(req("GET", "/api/upstreams"))

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual([])
    })

    test("returns list of providers with masked api_key", async () => {
      const app = makeApp(db)

      // Create two providers
      await app.request(req("POST", "/api/upstreams", {
        name: "AnthropicProvider",
        base_url: "https://anthropic.example.com",
        format: "anthropic",
        api_key: "sk-ant-1234567890abcdef",
        model_patterns: ["claude-*"],
        is_enabled: true,
      }))

      await app.request(req("POST", "/api/upstreams", {
        name: "OpenAIProvider",
        base_url: "https://openai.example.com",
        format: "openai",
        api_key: "sk-openai-1234567890abcdef",
        model_patterns: ["gpt-*"],
        is_enabled: false,
      }))

      const res = await app.request(req("GET", "/api/upstreams"))

      expect(res.status).toBe(200)
      const json = await res.json() as Array<{ name: string; api_key_preview: string; is_enabled: boolean }>
      expect(json).toHaveLength(2)

      const anthropic = json.find((p) => p.name === "AnthropicProvider")
      expect(anthropic?.api_key_preview).toBe("sk-ant-1...****")
      expect(anthropic?.is_enabled).toBe(true)

      const openai = json.find((p) => p.name === "OpenAIProvider")
      expect(openai?.api_key_preview).toBe("sk-opena...****")
      expect(openai?.is_enabled).toBe(false)
    })
  })

  describe("GET /api/upstreams/:id", () => {
    test("returns 404 for non-existent provider", async () => {
      const app = makeApp(db)
      const res = await app.request(req("GET", "/api/upstreams/nonexistent"))

      expect(res.status).toBe(404)
      const json = await res.json() as { error: { message: string } }
      expect(json.error.message).toBe("Provider not found")
    })

    test("returns provider with masked api_key", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-1234567890",
        model_patterns: ["test-model"],
      }))
      const created = await createRes.json() as { id: string }

      const res = await app.request(req("GET", `/api/upstreams/${created.id}`))

      expect(res.status).toBe(200)
      const json = await res.json() as { name: string; api_key_preview: string }
      expect(json.name).toBe("TestProvider")
      expect(json.api_key_preview).toBe("sk-test-...****")
    })
  })

  describe("POST /api/upstreams", () => {
    test("creates provider with valid input", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-model"],
      }))

      expect(res.status).toBe(201)
      const json = await res.json() as { id: string; name: string; is_enabled: boolean }
      expect(json.id).toBeDefined()
      expect(json.name).toBe("TestProvider")
      expect(json.is_enabled).toBe(true) // default
    })

    test("returns 400 for invalid URL", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "not-a-url",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-model"],
      }))

      expect(res.status).toBe(400)
    })

    test("returns 400 for invalid format", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "invalid",
        api_key: "sk-test-key",
        model_patterns: ["test-model"],
      }))

      expect(res.status).toBe(400)
    })

    test("returns 409 when model pattern conflicts with Copilot models", async () => {
      const app = makeApp(db)

      // Set state.models to simulate Copilot models
      const { state } = await import("../../src/lib/state")
      const savedModels = state.models
      state.models = { object: "list" as const, data: [
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", capabilities: {
          family: "anthropic",
          limits: { max_context_window_tokens: 200000, max_output_tokens: 8192, max_prompt_tokens: 200000, max_inputs: 100 },
          object: "model_capabilities",
          supports: { tool_calls: true, parallel_tool_calls: true, dimensions: true },
          tokenizer: "anthropic",
          type: "chat",
        }, model_picker_enabled: true, preview: false, vendor: "anthropic", version: "20241022", object: "model", policy: { state: "allowed", terms: "" } },
      ]}

      try {
        const res = await app.request(req("POST", "/api/upstreams", {
          name: "TestProvider",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "sk-test-key",
          model_patterns: ["claude-3-5-sonnet-20241022"],
        }))

        expect(res.status).toBe(409)
        const json = await res.json() as { error: { type: string; conflicts: string[] } }
        expect(json.error.type).toBe("model_conflict")
        expect(json.error.conflicts).toContain("claude-3-5-sonnet-20241022")
      } finally {
        state.models = savedModels
      }
    })

    test("allows glob patterns that overlap with Copilot models", async () => {
      const app = makeApp(db)

      // Set state.models to simulate Copilot models
      const { state } = await import("../../src/lib/state")
      const savedModels = state.models
      state.models = { object: "list" as const, data: [
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", capabilities: {
          family: "anthropic",
          limits: { max_context_window_tokens: 200000, max_output_tokens: 8192, max_prompt_tokens: 200000, max_inputs: 100 },
          object: "model_capabilities",
          supports: { tool_calls: true, parallel_tool_calls: true, dimensions: true },
          tokenizer: "anthropic",
          type: "chat",
        }, model_picker_enabled: true, preview: false, vendor: "anthropic", version: "20241022", object: "model", policy: { state: "allowed", terms: "" } },
      ]}

      try {
        // Glob pattern should be allowed even though it overlaps with Copilot model
        const res = await app.request(req("POST", "/api/upstreams", {
          name: "TestProvider",
          base_url: "https://example.com",
          format: "anthropic",
          api_key: "sk-test-key",
          model_patterns: ["claude-*"],  // Glob that would match claude-3-5-sonnet-20241022
        }))

        expect(res.status).toBe(201)
      } finally {
        state.models = savedModels
      }
    })

    test("allows glob and exact patterns to coexist", async () => {
      const app = makeApp(db)

      // Create first provider with glob pattern
      await app.request(req("POST", "/api/upstreams", {
        name: "Provider1",
        base_url: "https://example1.com",
        format: "anthropic",
        api_key: "sk-key1",
        model_patterns: ["glm-*"],
      }))

      // Create second provider with exact pattern that matches glob
      const res = await app.request(req("POST", "/api/upstreams", {
        name: "Provider2",
        base_url: "https://example2.com",
        format: "openai",
        api_key: "sk-key2",
        model_patterns: ["glm-5"],
      }))

      // Should succeed - exact-first routing means glm-5 routes to Provider2
      expect(res.status).toBe(201)
    })

    test("accepts valid glob patterns", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["gpt-*", "claude-*"],
      }))

      expect(res.status).toBe(201)
    })

    test("returns 409 when exact pattern conflicts with existing provider", async () => {
      const app = makeApp(db)

      // Create first provider
      await app.request(req("POST", "/api/upstreams", {
        name: "Provider1",
        base_url: "https://example1.com",
        format: "anthropic",
        api_key: "sk-key1",
        model_patterns: ["exact-model"],
      }))

      // Try to create second provider with same exact pattern
      const res = await app.request(req("POST", "/api/upstreams", {
        name: "Provider2",
        base_url: "https://example2.com",
        format: "openai",
        api_key: "sk-key2",
        model_patterns: ["exact-model"],
      }))

      expect(res.status).toBe(409)
      const json = await res.json() as { error: { conflicts: string[] } }
      expect(json.error.conflicts).toContain("exact-model")
    })
  })

  describe("PUT /api/upstreams/:id", () => {
    test("updates provider with valid input", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "OriginalName",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-original-key",
        model_patterns: ["original-model"],
      }))
      const created = await createRes.json() as { id: string }

      const res = await app.request(req("PUT", `/api/upstreams/${created.id}`, {
        name: "UpdatedName",
        base_url: "https://updated.com",
        model_patterns: ["updated-model"],
      }))

      expect(res.status).toBe(200)
      const json = await res.json() as { name: string; base_url: string }
      expect(json.name).toBe("UpdatedName")
      expect(json.base_url).toBe("https://updated.com")
    })

    test("returns 404 for non-existent provider", async () => {
      const app = makeApp(db)

      const res = await app.request(req("PUT", "/api/upstreams/nonexistent", {
        name: "UpdatedName",
      }))

      expect(res.status).toBe(404)
    })

    test("returns 400 for invalid input", async () => {
      const app = makeApp(db)

      const created = createProvider(db, {
        name: "Provider1",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-key1",
        model_patterns: ["model-1"],
      })

      const res = await app.request(req("PUT", `/api/upstreams/${created.id}`, {
        base_url: "not-a-url",
      }))

      expect(res.status).toBe(400)
      const json = await res.json() as { error: { message: string } }
      expect(json.error.message).toBe("Invalid input")
    })

    test("returns 409 when updated model patterns conflict", async () => {
      const app = makeApp(db)

      // Create two providers
      const p1Res = await app.request(req("POST", "/api/upstreams", {
        name: "Provider1",
        base_url: "https://example1.com",
        format: "anthropic",
        api_key: "sk-key1",
        model_patterns: ["model-1"],
      }))
      const p1 = await p1Res.json() as { id: string }

      await app.request(req("POST", "/api/upstreams", {
        name: "Provider2",
        base_url: "https://example2.com",
        format: "openai",
        api_key: "sk-key2",
        model_patterns: ["model-2"],
      }))

      // Try to update Provider1 to conflict with Provider2
      const res = await app.request(req("PUT", `/api/upstreams/${p1.id}`, {
        model_patterns: ["model-2"],
      }))

      expect(res.status).toBe(409)
    })

    test("allows updating provider with its own patterns unchanged", async () => {
      const app = makeApp(db)

      const p1Res = await app.request(req("POST", "/api/upstreams", {
        name: "Provider1",
        base_url: "https://example1.com",
        format: "anthropic",
        api_key: "sk-key1",
        model_patterns: ["model-1"],
      }))
      const p1 = await p1Res.json() as { id: string }

      // Update with same patterns should not conflict
      const res = await app.request(req("PUT", `/api/upstreams/${p1.id}`, {
        name: "UpdatedProvider1",
        model_patterns: ["model-1"],
      }))

      expect(res.status).toBe(200)
    })
  })

  describe("DELETE /api/upstreams/:id", () => {
    test("deletes existing provider", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "ToDelete",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-key",
        model_patterns: ["test"],
      }))
      const created = await createRes.json() as { id: string }

      const deleteRes = await app.request(req("DELETE", `/api/upstreams/${created.id}`))
      expect(deleteRes.status).toBe(200)

      // Verify deletion
      const getRes = await app.request(req("GET", `/api/upstreams/${created.id}`))
      expect(getRes.status).toBe(404)
    })

    test("returns 404 for non-existent provider", async () => {
      const app = makeApp(db)

      const res = await app.request(req("DELETE", "/api/upstreams/nonexistent"))
      expect(res.status).toBe(404)
    })

    test("returns success object", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "ToDelete",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-key",
        model_patterns: ["test"],
      }))
      const created = await createRes.json() as { id: string }

      const res = await app.request(req("DELETE", `/api/upstreams/${created.id}`))
      const json = await res.json() as { success: boolean }
      expect(json.success).toBe(true)
    })
  })

  describe("state refresh", () => {
    test("creating provider updates state.providers", async () => {
      const app = makeApp(db)

      // Check initial state
      let providers = getEnabledProviders(db)
      expect(providers).toHaveLength(0)

      // Create provider
      await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-key",
        model_patterns: ["test"],
      }))

      // State should be refreshed
      providers = getEnabledProviders(db)
      expect(providers).toHaveLength(1)
      expect(providers[0]?.name).toBe("TestProvider")
    })

    test("deleting provider updates state.providers", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "ToDelete",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-key",
        model_patterns: ["test"],
      }))
      const created = await createRes.json() as { id: string }

      // Verify provider exists
      let providers = getEnabledProviders(db)
      expect(providers).toHaveLength(1)

      // Delete provider
      await app.request(req("DELETE", `/api/upstreams/${created.id}`))

      // State should be refreshed
      providers = getEnabledProviders(db)
      expect(providers).toHaveLength(0)
    })
  })

  describe("when Copilot models are not loaded", () => {
    test("POST returns 503 when state.models is null", async () => {
      const app = makeApp(db)

      // Set state.models to null
      state.models = null

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-model"],
      }))

      expect(res.status).toBe(503)
      const json = await res.json() as { error: { type: string } }
      expect(json.error.type).toBe("service_unavailable")
    })

    test("PUT returns 503 when updating model_patterns and state.models is null", async () => {
      const app = makeApp(db)

      // Create a provider first (with models loaded)
      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-model"],
      }))
      const created = await createRes.json() as { id: string }

      // Set state.models to null
      state.models = null

      // Try to update model_patterns
      const res = await app.request(req("PUT", `/api/upstreams/${created.id}`, {
        model_patterns: ["new-model"],
      }))

      expect(res.status).toBe(503)
      const json = await res.json() as { error: { type: string } }
      expect(json.error.type).toBe("service_unavailable")
    })

    test("PUT succeeds when updating other fields without model_patterns", async () => {
      const app = makeApp(db)

      // Create a provider first (with models loaded)
      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-model"],
      }))
      const created = await createRes.json() as { id: string }

      // Set state.models to null
      state.models = null

      // Update other fields (not model_patterns) should still work
      const res = await app.request(req("PUT", `/api/upstreams/${created.id}`, {
        name: "UpdatedProvider",
      }))

      expect(res.status).toBe(200)
    })
  })

  describe("supports_reasoning field", () => {
    test("POST accepts supports_reasoning: true", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "ReasoningProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["o1*"],
        supports_reasoning: true,
      }))

      expect(res.status).toBe(201)
      const json = await res.json() as { supports_reasoning: boolean }
      expect(json.supports_reasoning).toBe(true)
    })

    test("POST defaults supports_reasoning to false when not specified", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "DefaultProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["gpt-*"],
      }))

      expect(res.status).toBe(201)
      const json = await res.json() as { supports_reasoning: boolean }
      expect(json.supports_reasoning).toBe(false)
    })

    test("POST rejects supports_reasoning with non-boolean value", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "InvalidProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["model"],
        supports_reasoning: "yes",
      }))

      expect(res.status).toBe(400)
    })

    test("PUT can update supports_reasoning field", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["o1*"],
        supports_reasoning: false,
      }))
      const created = await createRes.json() as { id: string; supports_reasoning: boolean }
      expect(created.supports_reasoning).toBe(false)

      const updateRes = await app.request(req("PUT", `/api/upstreams/${created.id}`, {
        supports_reasoning: true,
      }))

      expect(updateRes.status).toBe(200)
      const updated = await updateRes.json() as { supports_reasoning: boolean }
      expect(updated.supports_reasoning).toBe(true)
    })

    test("GET returns supports_reasoning field", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "ReasoningProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["o1*"],
        supports_reasoning: true,
      }))
      const created = await createRes.json() as { id: string }

      const res = await app.request(req("GET", `/api/upstreams/${created.id}`))
      expect(res.status).toBe(200)
      const json = await res.json() as { supports_reasoning: boolean }
      expect(json.supports_reasoning).toBe(true)
    })

    test("GET /api/upstreams returns supports_reasoning in list", async () => {
      const app = makeApp(db)

      await app.request(req("POST", "/api/upstreams", {
        name: "ReasoningProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["o1*"],
        supports_reasoning: true,
      }))

      await app.request(req("POST", "/api/upstreams", {
        name: "RegularProvider",
        base_url: "https://example.com",
        format: "openai",
        api_key: "sk-test-key",
        model_patterns: ["gpt-*"],
      }))

      const res = await app.request(req("GET", "/api/upstreams"))
      expect(res.status).toBe(200)
      const json = await res.json() as Array<{ name: string; supports_reasoning: boolean }>
      expect(json).toHaveLength(2)

      const reasoning = json.find((p) => p.name === "ReasoningProvider")
      expect(reasoning?.supports_reasoning).toBe(true)

      const regular = json.find((p) => p.name === "RegularProvider")
      expect(regular?.supports_reasoning).toBe(false)
    })
  })

  describe("supports_models_endpoint field", () => {
    test("POST creates provider with null supports_models_endpoint initially", async () => {
      const app = makeApp(db)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-*"],
      }))

      expect(res.status).toBe(201)
      const json = await res.json() as { supports_models_endpoint: boolean | null }
      // Initially null until probed
      expect(json.supports_models_endpoint).toBeNull()
    })

    test("GET returns supports_models_endpoint field", async () => {
      const app = makeApp(db)

      const createRes = await app.request(req("POST", "/api/upstreams", {
        name: "TestProvider",
        base_url: "https://example.com",
        format: "anthropic",
        api_key: "sk-test-key",
        model_patterns: ["test-*"],
      }))
      const created = await createRes.json() as { id: string }

      const res = await app.request(req("GET", `/api/upstreams/${created.id}`))
      expect(res.status).toBe(200)
      const json = await res.json() as { supports_models_endpoint: boolean | null }
      expect("supports_models_endpoint" in json).toBe(true)
    })
  })

  describe("GET /api/upstreams/:id/models", () => {
    test("returns 404 for non-existent provider", async () => {
      const app = makeApp(db)

      const res = await app.request(req("GET", "/api/upstreams/nonexistent/models"))
      expect(res.status).toBe(404)
    })

    test("returns grouped upstream models and marks the endpoint as supported", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "GroupedProvider",
        base_url: "https://models.example.com///",
        format: "openai",
        api_key: "sk-grouped",
        model_patterns: ["grouped-*"],
      })

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: "zeta", owned_by: "vendor-b" },
              { id: "alpha", owned_by: "vendor-b" },
              { id: "orphan" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))

      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://models.example.com/v1/models")

      const json = await res.json() as {
        healthy: boolean
        total: number
        models: Record<string, string[]>
      }
      expect(json).toEqual({
        healthy: true,
        total: 3,
        models: {
          "vendor-b": ["alpha", "zeta"],
          "unknown": ["orphan"],
        },
      })

      const updated = getProvider(db, provider.id)
      expect(updated?.supports_models_endpoint).toBe(true)
    })

    test("returns upstream errors and marks the endpoint as unsupported", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "BrokenProvider",
        base_url: "https://broken.example.com",
        format: "openai",
        api_key: "sk-broken",
        model_patterns: ["broken-*"],
      })

      fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))

      expect(res.status).toBe(502)
      const json = await res.json() as {
        error: { message: string; type: string }
        healthy: boolean
        supports_models_endpoint: boolean
      }
      expect(json).toEqual({
        error: {
          message: "Upstream returned 401: Unauthorized",
          type: "upstream_error",
        },
        healthy: false,
        supports_models_endpoint: false,
      })

      const updated = getProvider(db, provider.id)
      expect(updated?.supports_models_endpoint).toBe(false)
    })

    test("returns connection errors and marks the endpoint as unsupported", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "OfflineProvider",
        base_url: "https://offline.example.com",
        format: "anthropic",
        api_key: "sk-offline",
        model_patterns: ["offline-*"],
      })

      fetchSpy.mockRejectedValueOnce(new Error("socket hang up"))

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))

      expect(res.status).toBe(502)
      const json = await res.json() as {
        error: { message: string; type: string }
        healthy: boolean
        supports_models_endpoint: boolean
      }
      expect(json).toEqual({
        error: {
          message: "Failed to connect: socket hang up",
          type: "connection_error",
        },
        healthy: false,
        supports_models_endpoint: false,
      })

      const updated = getProvider(db, provider.id)
      expect(updated?.supports_models_endpoint).toBe(false)
    })

    test("ignores probe updates when the database closes before the background request finishes", async () => {
      const app = makeApp(db)
      let resolveFetch: ((response: Response) => void) | undefined

      fetchSpy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve as (response: Response) => void
          }),
      )

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "DelayedProbeProvider",
        base_url: "https://delayed.example.com",
        format: "openai",
        api_key: "sk-delayed",
        model_patterns: ["delayed-*"],
      }))

      expect(res.status).toBe(201)

      const probingDb = db
      probingDb.close()
      resolveFetch?.(
        new Response(
          JSON.stringify({ data: [{ id: "delayed-model" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      await Promise.resolve()

      db = new Database(":memory:")
      initProviders(db)
    })

    test("background probe on POST detects bearer for anthropic provider", async () => {
      const app = makeApp(db)

      // Bearer succeeds; x-api-key fails. The probe runs async post-POST.
      // Use a deferred promise so the test can await probe completion deterministically.
      const fetchPromises: Promise<Response>[] = []
      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        const auth = h.Authorization ?? h.authorization
        const p = auth?.startsWith("Bearer ")
          ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: "auto" }] }), { status: 200 }))
          : Promise.resolve(new Response("nope", { status: 401 }))
        fetchPromises.push(p)
        return p
      }) as unknown as typeof fetch)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "ManifestPost",
        base_url: "https://manifest.example",
        format: "anthropic",
        api_key: "mnfst_x",
        model_patterns: ["auto"],
      }))
      expect(res.status).toBe(201)
      const { id } = await res.json() as { id: string }

      // Wait for the background probe to settle (both fetches resolved).
      await Promise.all(fetchPromises)
      // Yield a tick so the DB write after `await tryAuth(...)` lands before assertion.
      await new Promise((r) => setTimeout(r, 5))

      const stored = getProvider(db, id)
      expect(stored?.auth_style).toBe("bearer")
      expect(stored?.supports_models_endpoint).toBe(true)
    })

    test("background probe on POST detects x-api-key for anthropic provider", async () => {
      const app = makeApp(db)

      const fetchPromises: Promise<Response>[] = []
      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        const hasKey = "x-api-key" in h || "X-Api-Key" in h
        const p = hasKey
          ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: "claude-3" }] }), { status: 200 }))
          : Promise.resolve(new Response("nope", { status: 401 }))
        fetchPromises.push(p)
        return p
      }) as unknown as typeof fetch)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "AnthropicDirectPost",
        base_url: "https://api.anthropic.com",
        format: "anthropic",
        api_key: "sk-anth",
        model_patterns: ["claude-*"],
      }))
      expect(res.status).toBe(201)
      const { id } = await res.json() as { id: string }

      await Promise.all(fetchPromises)
      await new Promise((r) => setTimeout(r, 5))

      const stored = getProvider(db, id)
      expect(stored?.auth_style).toBe("x-api-key")
      expect(stored?.supports_models_endpoint).toBe(true)
    })

    test("probe disambiguates auth_style from 401 vs non-401 even when /v1/models is missing", async () => {
      // Manifest-like: returns 401 on missing Authorization, 404 with Bearer
      // (e.g. endpoint not implemented). We should still record auth_style=bearer.
      const app = makeApp(db)

      const fetchPromises: Promise<Response>[] = []
      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        const auth = h.Authorization ?? h.authorization
        const p = auth?.startsWith("Bearer ")
          ? Promise.resolve(new Response("not found", { status: 404 }))
          : Promise.resolve(new Response("missing auth", { status: 401 }))
        fetchPromises.push(p)
        return p
      }) as unknown as typeof fetch)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "ManifestNoModels",
        base_url: "https://manifest-no-models.example",
        format: "anthropic",
        api_key: "mnfst_y",
        model_patterns: ["auto"],
      }))
      expect(res.status).toBe(201)
      const { id } = await res.json() as { id: string }

      await Promise.all(fetchPromises)
      await new Promise((r) => setTimeout(r, 5))

      const stored = getProvider(db, id)
      // /v1/models isn't reachable, but bearer is the right header.
      expect(stored?.supports_models_endpoint).toBe(false)
      expect(stored?.auth_style).toBe("bearer")
    })

    test("probe disambiguates auth_style when Bearer is rejected and x-api-key returns non-401", async () => {
      const app = makeApp(db)

      const fetchPromises: Promise<Response>[] = []
      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        const hasKey = "x-api-key" in h || "X-Api-Key" in h
        const p = hasKey
          ? Promise.resolve(new Response("not found", { status: 404 }))
          : Promise.resolve(new Response("missing key", { status: 401 }))
        fetchPromises.push(p)
        return p
      }) as unknown as typeof fetch)

      const res = await app.request(req("POST", "/api/upstreams", {
        name: "AnthropicNoModels",
        base_url: "https://anth-no-models.example",
        format: "anthropic",
        api_key: "sk-anth-2",
        model_patterns: ["claude-2"],
      }))
      expect(res.status).toBe(201)
      const { id } = await res.json() as { id: string }

      await Promise.all(fetchPromises)
      await new Promise((r) => setTimeout(r, 5))

      const stored = getProvider(db, id)
      expect(stored?.supports_models_endpoint).toBe(false)
      expect(stored?.auth_style).toBe("x-api-key")
    })
    test("anthropic provider: probe detects x-api-key and persists auth_style", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "AnthDirect",
        base_url: "https://api.anthropic.com",
        format: "anthropic",
        api_key: "sk-anth",
        model_patterns: ["claude-*"],
      })

      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        const hasKey = "x-api-key" in h || "X-Api-Key" in h
        if (hasKey) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "claude-3" }] }), { status: 200 }),
          )
        }
        return Promise.resolve(new Response("nope", { status: 401 }))
      }) as unknown as typeof fetch)

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))
      expect(res.status).toBe(200)
      const updated = getProvider(db, provider.id)
      expect(updated?.auth_style).toBe("x-api-key")
      expect(updated?.supports_models_endpoint).toBe(true)
    })

    test("anthropic provider: probe falls back to bearer and persists auth_style", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "Manifest",
        base_url: "https://manifest.example",
        format: "anthropic",
        api_key: "mnfst_x",
        model_patterns: ["auto"],
      })

      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        const auth = h.Authorization ?? h.authorization
        if (auth?.startsWith("Bearer ")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "auto" }] }), { status: 200 }),
          )
        }
        return Promise.resolve(new Response("missing Authorization", { status: 401 }))
      }) as unknown as typeof fetch)

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))
      expect(res.status).toBe(200)
      const updated = getProvider(db, provider.id)
      expect(updated?.auth_style).toBe("bearer")
      expect(updated?.supports_models_endpoint).toBe(true)
    })

    test("probe refreshes runtime cache so messages path picks up auth_style", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "Manifest",
        base_url: "https://manifest.example",
        format: "anthropic",
        api_key: "mnfst_x",
        model_patterns: ["auto"],
      })

      // Seed state.providers with the OLD auth_style=null so we can detect refresh.
      state.providers = getEnabledProviders(db)
        .map((r) => ({ ...r, auth_style: null, patterns: [{ raw: "auto", isExact: true }] }))

      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const auth = init?.headers?.Authorization ?? init?.headers?.authorization
        if (auth?.startsWith("Bearer ")) {
          return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "auto" }] }), { status: 200 }))
        }
        return Promise.resolve(new Response("missing Authorization", { status: 401 }))
      }) as unknown as typeof fetch)

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))
      expect(res.status).toBe(200)
      const cached = state.providers?.find((p) => p.id === provider.id)
      expect(cached?.auth_style).toBe("bearer")
    })

    test("openai provider: health check does NOT fall back to x-api-key", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "OpenAiOnly",
        base_url: "https://openai.example",
        format: "openai",
        api_key: "sk-bearer-only",
        model_patterns: ["gpt-*"],
      })

      // Bearer fails, x-api-key would succeed if attempted — health check
      // must NOT try x-api-key for openai providers (runtime won't either).
      const seen: string[] = []
      fetchSpy.mockImplementation(((_url: string, init?: { headers?: Record<string, string> }) => {
        const h = init?.headers ?? {}
        if ("x-api-key" in h || "X-Api-Key" in h) seen.push("x-api-key")
        if (h.Authorization ?? h.authorization) seen.push("bearer")
        return Promise.resolve(new Response("forbidden", { status: 401 }))
      }) as unknown as typeof fetch)

      const res = await app.request(req("GET", `/api/upstreams/${provider.id}/models`))
      expect(res.status).toBe(502)
      expect(seen).toEqual(["bearer"])
      expect(seen).not.toContain("x-api-key")
    })
  })

  describe("PUT /api/upstreams/:id auth_style reset", () => {
    test("changing base_url clears stored auth_style", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "Manifest",
        base_url: "https://manifest.old.example",
        format: "anthropic",
        api_key: "mnfst_x",
        model_patterns: ["auto"],
      })
      // Simulate prior probe writing auth_style.
      db.query("UPDATE providers SET auth_style = 'bearer' WHERE id = $id")
        .run({ $id: provider.id })

      // Re-probe will fire — make it hang so we don't race the assertion.
      fetchSpy.mockImplementation((() => new Promise(() => {})) as unknown as typeof fetch)

      const res = await app.request(req("PUT", `/api/upstreams/${provider.id}`, {
        base_url: "https://manifest.new.example",
      }))
      expect(res.status).toBe(200)

      const updated = getProvider(db, provider.id)
      expect(updated?.auth_style).toBeNull()
    })

    test("changing api_key clears stored auth_style", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "Manifest",
        base_url: "https://manifest.example",
        format: "anthropic",
        api_key: "mnfst_old",
        model_patterns: ["auto"],
      })
      db.query("UPDATE providers SET auth_style = 'bearer' WHERE id = $id")
        .run({ $id: provider.id })

      fetchSpy.mockImplementation((() => new Promise(() => {})) as unknown as typeof fetch)

      const res = await app.request(req("PUT", `/api/upstreams/${provider.id}`, {
        api_key: "mnfst_new",
      }))
      expect(res.status).toBe(200)

      const updated = getProvider(db, provider.id)
      expect(updated?.auth_style).toBeNull()
    })

    test("changing format clears auth_style and re-probes models endpoint", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "FormatSwitcher",
        base_url: "https://format.example",
        format: "anthropic",
        api_key: "sk-format",
        model_patterns: ["switch-*"],
      })
      db.query("UPDATE providers SET auth_style = 'bearer', supports_models_endpoint = 0 WHERE id = $id")
        .run({ $id: provider.id })

      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "switch-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )

      const res = await app.request(req("PUT", `/api/upstreams/${provider.id}`, {
        format: "openai",
      }))
      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>
      expect(headers.Authorization).toBe("Bearer sk-format")
      expect("x-api-key" in headers).toBe(false)

      await Promise.resolve()
      await Promise.resolve()

      const updated = getProvider(db, provider.id)
      expect(updated?.format).toBe("openai")
      expect(updated?.auth_style).toBeNull()
      expect(updated?.supports_models_endpoint).toBe(true)
    })

    test("touching only name keeps stored auth_style", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "Manifest",
        base_url: "https://manifest.example",
        format: "anthropic",
        api_key: "mnfst_x",
        model_patterns: ["auto"],
      })
      db.query("UPDATE providers SET auth_style = 'bearer' WHERE id = $id")
        .run({ $id: provider.id })

      const res = await app.request(req("PUT", `/api/upstreams/${provider.id}`, {
        name: "Manifest Renamed",
      }))
      expect(res.status).toBe(200)

      const updated = getProvider(db, provider.id)
      expect(updated?.auth_style).toBe("bearer")
    })

    test("explicit auth_style in PUT overrides reset", async () => {
      const app = makeApp(db)
      const provider = createProvider(db, {
        name: "Manifest",
        base_url: "https://manifest.example",
        format: "anthropic",
        api_key: "mnfst_x",
        model_patterns: ["auto"],
      })
      db.query("UPDATE providers SET auth_style = 'bearer' WHERE id = $id")
        .run({ $id: provider.id })

      fetchSpy.mockImplementation((() => new Promise(() => {})) as unknown as typeof fetch)

      const res = await app.request(req("PUT", `/api/upstreams/${provider.id}`, {
        base_url: "https://manifest.new.example",
        auth_style: "x-api-key",
      }))
      expect(res.status).toBe(200)

      const updated = getProvider(db, provider.id)
      expect(updated?.auth_style).toBe("x-api-key")
    })
  })
})
