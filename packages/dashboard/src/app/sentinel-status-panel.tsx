"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, RefreshCcw, Activity } from "lucide-react";
import { DashboardSegment } from "@/components/layout/dashboard-segment";
import { useRingBuffer } from "@/hooks/use-ring-buffer";
import {
  derive401Slices,
  deriveRetryStacks,
} from "@/lib/sentinel-derive";
import type { SentinelStatus } from "@/lib/types";
import { OccurrencesDonut } from "./sentinel/occurrences-donut";
import { RetryBar } from "./sentinel/retry-bar";
import { LiveState } from "./sentinel/live-state";

// ---------------------------------------------------------------------------
// SentinelStatusPanel — orchestrator
//
// Polls /api/sentinel-status every 5 s, feeds derived data into three
// pure-render subcomponents (donut / bar / live state). Keeps a ring
// buffer of recent signalScore values so the LiveState panel can show
// an inline sparkline of the last ~5 minutes.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const SIGNAL_HISTORY_LEN = 60; // ~5 minutes at 5 s poll

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
    <div className="bg-secondary rounded-card p-3 md:p-4 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-card-label font-medium">{title}</h3>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

interface SentinelStatusPanelProps {
  initialData?: SentinelStatus | null;
}

export function SentinelStatusPanel({ initialData = null }: SentinelStatusPanelProps) {
  const [data, setData] = useState<SentinelStatus | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const signal = useRingBuffer<number>(SIGNAL_HISTORY_LEN);

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
          signal.push(body.signalScore);
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
  }, [signal]);

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
  const slices = derive401Slices(c);
  const retry = deriveRetryStacks(c);

  const bgRefreshOk =
    c.refreshSucceededTokenUpdatedByReason.scheduled +
    c.refreshSucceededTokenUpdatedByReason.sentinel401 +
    c.refreshSucceededTokenUpdatedByReason.manual;
  const bgRefreshFailed =
    c.refreshFailedByReason.scheduled +
    c.refreshFailedByReason.sentinel401 +
    c.refreshFailedByReason.manual;

  return (
    <DashboardSegment title="Token Refresh Sentinel">
      {error && (
        <p className="text-meta text-destructive">Stale: {error}</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 items-stretch">
        <PanelShell title="401 Occurrences" icon={ShieldAlert}>
          <OccurrencesDonut slices={slices} />
        </PanelShell>

        <PanelShell title="LLM-401 Auto Retry" icon={RefreshCcw}>
          <RetryBar stacks={retry} />
        </PanelShell>

        <PanelShell
          title="Live State"
          icon={data.mode === "probing" ? Activity : ShieldCheck}
        >
          <LiveState
            status={data}
            signalHistory={signal.snapshot()}
            bgRefreshOk={bgRefreshOk}
            bgRefreshFailed={bgRefreshFailed}
          />
        </PanelShell>
      </div>
    </DashboardSegment>
  );
}
