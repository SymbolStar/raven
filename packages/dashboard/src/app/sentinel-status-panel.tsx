"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, RefreshCcw, Activity } from "lucide-react";
import { DashboardSegment } from "@/components/layout/dashboard-segment";
import { formatCompact } from "@/lib/chart-config";
import type { SentinelStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// SentinelStatusPanel — observability for Copilot token-refresh sentinel
//
// Polls /api/sentinel-status every 5s. Three panels:
//   1. 401 occurrences — counts of upstream-reported 401s the proxy saw
//   2. Auto-retry outcomes — how the sentinel + retry path responded
//   3. Live state — current mode / cooldown / signal score / counters
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;

interface MetricCellProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "warn" | "danger";
}

function MetricCell({ label, value, hint, tone = "default" }: MetricCellProps) {
  const toneClass =
    tone === "danger"
      ? "text-destructive"
      : tone === "warn"
      ? "text-amber-500"
      : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className={`text-numeric font-medium tabular-nums ${toneClass}`}>
        {typeof value === "number" ? formatCompact(value) : value}
      </span>
      {hint && <span className="text-meta text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

function PanelShell({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof ShieldAlert;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-secondary rounded-card p-3 md:p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-card-label font-medium">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatAge(timestampMs: number): string {
  if (!timestampMs) return "—";
  const age = Date.now() - timestampMs;
  if (age < 0) return "now";
  if (age < 60_000) return `${Math.round(age / 1_000)}s ago`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
  return `${Math.round(age / 3_600_000)}h ago`;
}

interface SentinelStatusPanelProps {
  initialData?: SentinelStatus | null;
}

export function SentinelStatusPanel({ initialData = null }: SentinelStatusPanelProps) {
  const [data, setData] = useState<SentinelStatus | null>(initialData);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/sentinel-status");
        if (!res.ok) {
          if (alive) setError(`HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as SentinelStatus;
        if (alive) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (error && !data) {
    return (
      <DashboardSegment title="Token Refresh Sentinel">
        <div className="bg-secondary rounded-card p-4">
          <p className="text-meta text-destructive">Failed to load: {error}</p>
        </div>
      </DashboardSegment>
    );
  }

  if (!data) {
    return (
      <DashboardSegment title="Token Refresh Sentinel">
        <div className="bg-secondary rounded-card p-4">
          <p className="text-meta text-muted-foreground">Loading…</p>
        </div>
      </DashboardSegment>
    );
  }

  const c = data.counters;
  const llmTotal = c.llm401TokenExpired + c.llm401Other;
  const retrySuccess = c.refreshSucceededTokenUpdated;
  const retryFailed = c.refreshFailed;

  const modeBadge =
    data.mode === "probing"
      ? { label: "PROBING", tone: "warn" as const }
      : data.mode === "steady"
      ? { label: "STEADY", tone: "default" as const }
      : { label: "OFFLINE", tone: "danger" as const };

  return (
    <DashboardSegment title="Token Refresh Sentinel">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
        {/* Panel 1: 401 occurrences */}
        <PanelShell title="401 Occurrences" icon={ShieldAlert}>
          <div className="grid grid-cols-2 gap-3">
            <MetricCell
              label="Total LLM 401"
              value={llmTotal}
              tone={llmTotal > 0 ? "warn" : "default"}
            />
            <MetricCell
              label="Token Expired"
              value={c.llm401TokenExpired}
              hint="Recoverable — auto-retried"
            />
            <MetricCell
              label="Other 401"
              value={c.llm401Other}
              hint="Not recoverable"
            />
            <MetricCell
              label="cacheModels 401"
              value={c.cacheModels401}
              hint="Sentinel /models probe"
            />
          </div>
        </PanelShell>

        {/* Panel 2: Auto-retry outcomes */}
        <PanelShell title="Auto Retry" icon={RefreshCcw}>
          <div className="grid grid-cols-2 gap-3">
            <MetricCell
              label="Token Refreshed"
              value={retrySuccess}
              hint="Success — user unaware"
            />
            <MetricCell
              label="Refresh Failed"
              value={retryFailed}
              tone={retryFailed > 0 ? "danger" : "default"}
            />
            <MetricCell
              label="Cooldown Blocked"
              value={c.refreshBlockedByCooldown}
              hint="Saved from upstream"
            />
            <MetricCell
              label="Min-interval Skip"
              value={c.refreshBlockedByMinInterval}
              hint="Within 30s window"
            />
            <MetricCell
              label="Short-circuit"
              value={c.refreshShortCircuit}
              hint="Token already fresh"
            />
            <MetricCell
              label="Stale Discarded"
              value={c.refreshDiscardedStale}
              hint="Old loop result"
            />
          </div>
        </PanelShell>

        {/* Panel 3: Live state */}
        <PanelShell title="Live State" icon={data.mode === "probing" ? Activity : ShieldCheck}>
          <div className="grid grid-cols-2 gap-3">
            <MetricCell
              label="Mode"
              value={modeBadge.label}
              tone={modeBadge.tone}
            />
            <MetricCell
              label="Signal Score"
              value={data.signalScore}
              hint="0-10 (threshold 5)"
            />
            <MetricCell
              label="Cooldown"
              value={formatMs(data.cooldownRemainingMs)}
              tone={data.cooldownRemainingMs > 0 ? "warn" : "default"}
            />
            <MetricCell
              label="Consecutive Fails"
              value={data.consecutiveFailures}
              tone={data.consecutiveFailures > 0 ? "warn" : "default"}
            />
            <MetricCell
              label="Last Success"
              value={formatAge(data.lastSuccessAt)}
            />
            <MetricCell
              label="Upstream Calls"
              value={c.refreshUpstreamCalls}
              hint="Cumulative"
            />
          </div>
        </PanelShell>
      </div>
    </DashboardSegment>
  );
}
