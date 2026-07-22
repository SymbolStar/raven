# CarHer + Raven + Pi Runbook

This document records the local CarHer gateway experiment. It is intended for
personal development use and contains no real API keys.

## What Was Built

Raven was extended from a Copilot-focused local proxy into a local gateway for
CarHer OpenAI Responses traffic:

```text
Pi -> Raven (localhost:7025) -> CarHer Pro (/pro/v1/responses)
```

The new `custom-responses` strategy is selected when a Responses API request
matches an enabled OpenAI-format custom provider. It preserves the request
payload, forwards streaming and non-streaming Responses API results, and logs
the request to Raven's SQLite database and Dashboard.

The gateway also normalizes a compatibility variant where an upstream puts the
Responses event name only in JSON `type` instead of the SSE `event:` field.
Pi requires the standard event name to recognize `response.completed` and end
a stream correctly.

## Repository Setup

The local repository is at:

```text
/Users/fujindong/symbolstar/raven
```

Git remotes and branch:

```text
origin   https://github.com/SymbolStar/raven.git
upstream https://github.com/nocoo/raven.git
branch   feature/carher-gateway
```

The upstream repository remains available for future syncs; changes should be
committed to the feature branch before pushing to the personal fork.

## Implemented Changes

Key code paths:

| Area | Change |
| --- | --- |
| `upstream/custom-responses.ts` | Calls `<provider base URL>/responses` with Bearer auth and preserves JSON/SSE payloads. |
| `strategies/custom-responses.ts` | Preserves Responses events, records metrics, and infers a missing SSE event name from JSON `type`. |
| `core/router.ts` | Routes Responses requests to an OpenAI-format custom provider rather than rejecting them. |
| `routes/responses/handler.ts` | Resolves the matched provider and dispatches its original payload to the new strategy. |
| Dashboard connection info | Publishes and displays `/v1/responses`. |
| `RAVEN_DISABLE_COPILOT` | Defaults to custom providers only. Set it to `false` only when GitHub Copilot is required. |

The detailed feature design is in [CarHer Responses Gateway](./24-carher-responses-gateway.md).

## Prerequisites

Install the project runtime and dependencies:

```bash
brew install oven-sh/bun/bun
cd /Users/fujindong/symbolstar/raven
bun install
```

Pi is installed locally and supports custom providers through
`~/.pi/agent/models.json`.

## Tests Run

The following checks passed after the implementation:

```bash
bun run --filter @raven/proxy typecheck
bun run --filter dashboard typecheck

cd packages/proxy
bunx --bun vitest run \
  test/strategies/custom-responses.test.ts \
  test/upstream/custom-responses.test.ts \
  test/routes/responses/handler.test.ts \
  test/core/router.test.ts
```

Relevant focused tests passed: 53 tests across 4 test files. Earlier focused
coverage for the initial strategy and registry changes also passed.

`bun run --filter @raven/proxy test` has unrelated failures in SOCKS5 bridge
tests inside the Codex sandbox because those tests need local socket listeners.
The Responses tests pass independently.

## Run Raven

For the CarHer-only experiment, run Raven without Copilot initialization. This
avoids a GitHub/Copilot token refresh failure affecting an unrelated provider.

```bash
cd /Users/fujindong/symbolstar/raven

RAVEN_PORT=7025 \
RAVEN_API_KEY='<local-raven-api-key>' \
RAVEN_INTERNAL_KEY='<dashboard-internal-key>' \
bun run --filter @raven/proxy start
```

Expected startup messages:

```text
Copilot integration disabled; custom upstream providers remain available
Raven proxy listening on port 7025
```

Raven stores its runtime data locally at:

```text
~/Library/Application Support/raven/
```

This includes the SQLite database (`raven.db`) and, when Copilot mode is used,
the GitHub token. Do not commit these files.

## Run Dashboard

In a second terminal:

```bash
cd /Users/fujindong/symbolstar/raven/packages/dashboard

RAVEN_PROXY_URL='http://localhost:7025' \
RAVEN_INTERNAL_KEY='<dashboard-internal-key>' \
bunx --bun next dev -p 7023
```

Open <http://localhost:7023>.

The `Providers` screen is analytics only. Provider configuration is at:

```text
Settings -> Upstreams
http://localhost:7023/settings/upstreams
```

## Configure CarHer

The CarHer Pro Responses provider is configured and enabled in
`Settings -> Upstreams`:

| Field | Value |
| --- | --- |
| Name | `CarHer Pro` |
| Base URL | `https://cc.auto-link.com.cn/pro/v1` |
| Format | `openai` |
| API Key | Your CarHer Pro key |
| Model patterns | `gpt-5.6-*` |
| Supports reasoning | Enabled |

Do not add `/responses` to the base URL: Raven appends it. The final upstream
request URL is:

```text
https://cc.auto-link.com.cn/pro/v1/responses
```

The CarHer key is stored in Raven's local provider database and should never be
placed in Pi configuration or committed to the repository.

## Pi Configuration

The experiment model configuration exists in both locations:

```text
~/.pi/agent/models.json
/Users/fujindong/symbolstar/raven/.pi-raven-experiment/models.json
```

It defines:

```text
provider: raven-carher
baseUrl:  http://localhost:7025/v1
api:      openai-responses
model:    gpt-5.6-terra
```

Pi authenticates to Raven with a local Raven API key, not the CarHer key. Keep
the key in an environment variable:

```bash
export RAVEN_EXPERIMENT_KEY='<local-raven-api-key>'
```

Start Pi:

```bash
pi --provider raven-carher --model gpt-5.6-terra
```

For a one-off isolated session, use the project-specific Pi configuration:

```bash
cd /Users/fujindong/symbolstar/raven
PI_CODING_AGENT_DIR="$PWD/.pi-raven-experiment" \
RAVEN_EXPERIMENT_KEY='<local-raven-api-key>' \
pi --provider raven-carher --model gpt-5.6-terra
```

## Context Window

Pi's context display comes from its local `contextWindow` setting. It is not
auto-discovered from Raven in the current setup.

The experiment configuration was updated from `128000` to `353000` based on
the active session setting. Pi should show `/353k` after restarting its
session. This is an operational setting, not independently verified CarHer
model metadata; confirm the actual model window with the internal provider
documentation before increasing it further.

## Smoke Test

After Raven and Dashboard are running, use Pi to send a short prompt:

```text
Reply with exactly: raven connected
```

This is a real CarHer call. A successful request should show in Dashboard
Requests/Logs with:

```text
model:    gpt-5.6-terra
strategy: custom-responses
upstream: CarHer Pro
```

## Troubleshooting

| Symptom | Meaning and fix |
| --- | --- |
| `Failed to get Copilot token` | Ensure `RAVEN_DISABLE_COPILOT` is unset or `true`. Copilot is disabled by default. |
| GitHub `502 Unicorn` at startup | Ensure `RAVEN_DISABLE_COPILOT` is unset or `true`; this is a Copilot/GitHub initialization issue, not CarHer. |
| Provider save returns `503 Service Unavailable` in CarHer-only mode | Restart Raven with the current code. Custom-provider-only mode now skips the unavailable Copilot catalog check while retaining custom-provider conflict checks. |
| Pi says stream ended before terminal response event | Restart Raven with the current `custom-responses` compatibility fix, then retry. |
| Pi shows `/128k` | Restart Pi after confirming `contextWindow` is `353000` in `~/.pi/agent/models.json`. |
| No `Add Provider` button | Use `Settings -> Upstreams`, not the analytics-only `Providers` page. |
| Dashboard cannot reach Raven | Confirm `RAVEN_PROXY_URL=http://localhost:7025` and the matching `RAVEN_INTERNAL_KEY`. |
| Port already in use | Choose an unused local port and update both Raven's `RAVEN_PORT` and Dashboard's `RAVEN_PROXY_URL`. |

## Current Scope and Follow-ups

Implemented now:

- CarHer OpenAI Responses API through Raven.
- Pi as the isolated experiment client.
- Raven Dashboard request logging and provider management.

Not implemented yet:

- Automatic authoritative context-window discovery for CarHer model aliases.
- Any migration of existing Codex configuration. Keep Codex direct to the
  company gateway until the Pi experiment is stable.

## CarHer Anthropic Provider

CarHer Anthropic uses a separate key and provider entry. It is configured and
enabled in `Settings -> Upstreams` with the following values:

| Field | Value |
| --- | --- |
| Name | `CarHer Anthropic` |
| Base URL | `https://cc.auto-link.com.cn/pro` |
| Format | `anthropic` |
| API Key | Your separate CarHer Claude key |
| Model patterns | `anthropic.claude-*` |
| Strict Protocol Passthrough | Enabled |

Strict passthrough preserves native Anthropic thinking and context-management
fields. This provider must remain separate from the CarHer Pro Responses
provider because their base URLs, protocols, and keys differ.

Current provider routing:

```text
gpt-5.6-*            -> CarHer Pro -> /pro/v1/responses
anthropic.claude-*    -> CarHer Anthropic -> /pro/v1/messages
```
