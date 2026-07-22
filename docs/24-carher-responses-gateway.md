# CarHer Responses Gateway

Raven can route OpenAI Responses API requests to an OpenAI-compatible custom
provider. The path is protocol-preserving: request JSON and SSE events pass
through unchanged, while Raven supplies local authentication, routing, logs,
and Dashboard metrics.

## CarHer setup

Create a custom upstream in the Dashboard with these values:

| Field | Value |
| --- | --- |
| Name | `CarHer Pro` |
| Base URL | `https://cc.auto-link.com.cn/pro/v1` |
| Format | `openai` |
| API key | Your CarHer Pro key |
| Model patterns | `gpt-5.6-*` (add only models assigned to this upstream) |

Raven appends `/responses`, so the effective upstream endpoint is
`https://cc.auto-link.com.cn/pro/v1/responses`.

## Client use

Keep existing client configuration unchanged during rollout. A later client
profile can use Raven's `http://localhost:7024/v1` base URL and a Raven API
key. Do not point a production client at Raven until the provider and local
proxy have been verified with a short request.

## Scope

This feature covers OpenAI Responses-compatible clients such as Codex and Pi.
CarHer Anthropic Messages support is configured as a separate provider because
it uses a distinct `/pro` base URL and a separate key. Select Anthropic format,
enable `Strict Protocol Passthrough`, and route `anthropic.claude-*` models to
preserve native thinking and context-management fields.
