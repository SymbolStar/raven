/**
 * Pure derivation helpers for SentinelStatusPanel sub-components.
 *
 * Splitting the math out of the React tree keeps the panel a thin
 * orchestrator and lets us unit-test the percent math, color mapping,
 * and tick formatters without rendering recharts.
 */

import { CHART_COLORS } from "@/lib/chart-config";
import type { SentinelCounters } from "@/lib/types";

// ---------------------------------------------------------------------------
// Donut: 401 occurrences
// ---------------------------------------------------------------------------

export type OccurrenceKey = "expired" | "other" | "cacheModels";

export interface OccurrenceSlice {
  key: OccurrenceKey;
  label: string;
  value: number;
  color: string;
}

export function derive401Slices(c: SentinelCounters): OccurrenceSlice[] {
  return [
    {
      key: "expired",
      label: "Token Expired",
      value: c.llm401TokenExpired,
      color: CHART_COLORS.success,
    },
    {
      key: "other",
      label: "Other 401",
      value: c.llm401Other,
      color: CHART_COLORS.danger,
    },
    {
      key: "cacheModels",
      label: "cacheModels Probe",
      value: c.cacheModels401,
      color: CHART_COLORS.muted,
    },
  ];
}

// ---------------------------------------------------------------------------
// Stacked bar: LLM-401 auto-retry outcomes
// ---------------------------------------------------------------------------

export type RetryKey =
  | "refreshed"
  | "same"
  | "failed"
  | "shortCircuit"
  | "cooldown"
  | "minInterval";

export interface RetrySegment {
  key: RetryKey;
  label: string;
  value: number;
  color: string;
}

export interface RetryStacks {
  segments: RetrySegment[];
  total: number;
}

export function deriveRetryStacks(c: SentinelCounters): RetryStacks {
  const segments: RetrySegment[] = [
    {
      key: "refreshed",
      label: "Refreshed",
      value: c.refreshSucceededTokenUpdatedByReason.llm401,
      color: CHART_COLORS.success,
    },
    {
      key: "same",
      label: "Same Token",
      value: c.refreshSucceededTokenSameByReason.llm401,
      color: CHART_COLORS.muted,
    },
    {
      key: "failed",
      label: "Failed",
      value: c.refreshFailedByReason.llm401,
      color: CHART_COLORS.danger,
    },
    {
      key: "shortCircuit",
      label: "Short-circuit",
      value: c.refreshShortCircuitByReason.llm401,
      color: CHART_COLORS.warning,
    },
    {
      key: "cooldown",
      label: "Cooldown",
      value: c.refreshBlockedByCooldownByReason.llm401,
      color: CHART_COLORS.warning,
    },
    {
      key: "minInterval",
      label: "Min-interval",
      value: c.refreshBlockedByMinIntervalByReason.llm401,
      color: CHART_COLORS.muted,
    },
  ];

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return { segments, total };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Integer percent of `part / total`, floored. Returns 0 when total
 * is zero / negative — callers usually short-circuit empty-state UI
 * before reaching this, but be defensive anyway.
 */
export function computePercent(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  if (part <= 0) return 0;
  return Math.floor((part / total) * 100);
}

export function formatMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatAge(timestampMs: number, now: number = Date.now()): string {
  if (!timestampMs) return "—";
  const age = now - timestampMs;
  if (age < 0) return "now";
  if (age < 60_000) return `${Math.round(age / 1_000)}s ago`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
  return `${Math.round(age / 3_600_000)}h ago`;
}
