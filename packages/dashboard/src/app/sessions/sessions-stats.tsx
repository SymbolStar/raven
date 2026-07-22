"use client";

import { ListChecks, Activity, Zap, Clock } from "lucide-react";
import { StatCard } from "@/components/stats/stat-card";
import { useLocale } from "@/components/locale-provider";
import { formatCompact } from "@/lib/chart-config";

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function SessionsStats({ totalSessions, totalRequests, totalTokens, averageDurationMs }: { totalSessions: number; totalRequests: number; totalTokens: number; averageDurationMs: number }) {
  const { t } = useLocale();
  return <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4"><StatCard icon={ListChecks} label={t("totalSessions")} value={formatCompact(totalSessions)} /><StatCard icon={Activity} label={t("totalRequests")} value={formatCompact(totalRequests)} /><StatCard icon={Zap} label={t("totalTokens")} value={formatCompact(totalTokens)} /><StatCard icon={Clock} label={t("averageSessionDuration")} value={formatDuration(averageDurationMs)} /></div>;
}
