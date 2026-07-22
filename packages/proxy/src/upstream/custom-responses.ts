/**
 * OpenAI Responses-compatible upstream client.
 *
 * Unlike the Copilot client, this deliberately preserves the request and SSE
 * protocol so providers such as CarHer receive the same payload as the client.
 */

import type { CompiledProvider } from "../db/providers"
import { HTTPError } from "../lib/error"
import { getProxyUrl } from "../lib/socks5-bridge"
import { state } from "../lib/state"
import { events, type ServerSentEvent } from "../util/sse"
import type { ResponsesPayload } from "./copilot-responses"
import type { UpstreamClient, UpstreamResult } from "./interface"

export interface CustomResponsesRequest {
  provider: CompiledProvider
  payload: ResponsesPayload
}

export interface CustomResponsesConfig {
  getProxyUrl(provider: CompiledProvider): string | undefined
}

export class CustomResponsesClient
  implements UpstreamClient<CustomResponsesRequest, unknown>
{
  constructor(private readonly config: CustomResponsesConfig) {}

  async send(req: CustomResponsesRequest): Promise<UpstreamResult<unknown>> {
    const { provider, payload } = req
    const url = `${provider.base_url.replace(/\/+$/, "")}/responses`
    const proxyUrl = this.config.getProxyUrl(provider)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify(payload),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    } as RequestInit)

    if (!response.ok) {
      throw await HTTPError.fromResponse(
        `Upstream ${provider.name} returned ${response.status}`,
        response,
      )
    }

    return payload.stream
      ? (events(response) as AsyncGenerator<ServerSentEvent>)
      : await response.json()
  }
}

export function defaultCustomResponsesConfig(): CustomResponsesConfig {
  return { getProxyUrl: (provider) => getProxyUrl(provider, state) }
}

export function createDefaultCustomResponsesClient(): CustomResponsesClient {
  return new CustomResponsesClient(defaultCustomResponsesConfig())
}
