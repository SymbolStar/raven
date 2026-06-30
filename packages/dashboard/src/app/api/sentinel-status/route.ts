import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";
import type { SentinelStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await proxyFetch<SentinelStatus>("/api/sentinel-status");
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
