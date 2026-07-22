"use client";

import { Activity, Zap, Clock, AlertTriangle, Timer, Gauge } from "lucide-react";
import { StatCard } from "@/components/stats/stat-card";
import { useLocale } from "@/components/locale-provider";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import type { Percentiles, SummaryStats } from "@/lib/types";

export function OverviewStats({ summary, p95, requestsSpark, tokensSpark, latencySpark }: {
  summary: SummaryStats;
  p95: Percentiles | null;
  requestsSpark: number[];
  tokensSpark: number[];
  latencySpark: number[];
}) {
  const { t } = useLocale();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 md:gap-4">
      <StatCard icon={Activity} label={t("totalRequests")} value={formatCompact(summary.total_requests)} sparkline={requestsSpark} className="animate-fade-up stagger-1" />
      <StatCard icon={AlertTriangle} label={t("errorRate")} value={formatPercent(summary.error_rate)} detail={`${summary.error_count} ${t("errors")}`} accent={summary.error_rate > 0.05 ? "danger" : "default"} className="animate-fade-up stagger-2" />
      <StatCard icon={Clock} label={t("averageLatency")} value={formatLatency(summary.avg_latency_ms)} sparkline={latencySpark} className="animate-fade-up stagger-3" />
      <StatCard icon={Gauge} label={t("p95Latency")} value={p95 ? formatLatency(p95.p95) : "—"} className="animate-fade-up stagger-4" />
      <StatCard icon={Timer} label={t("averageTtft")} value={summary.avg_ttft_ms != null ? formatLatency(summary.avg_ttft_ms) : "—"} className="animate-fade-up stagger-5" />
      <StatCard icon={Zap} label={t("totalTokens")} value={formatCompact(summary.total_tokens)} sparkline={tokensSpark} className="animate-fade-up stagger-6" />
    </div>
  );
}
