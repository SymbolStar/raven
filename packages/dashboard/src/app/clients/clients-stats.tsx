"use client";
import { Users, Activity, Zap, AlertTriangle } from "lucide-react";
import { StatCard } from "@/components/stats/stat-card";
import { useLocale } from "@/components/locale-provider";
import { formatCompact, formatPercent } from "@/lib/chart-config";
export function ClientsStats({ clients, requests, tokens, errorRate }: { clients: number; requests: number; tokens: number; errorRate: number }) { const { t } = useLocale(); return <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4"><StatCard icon={Users} label={t("totalClients")} value={formatCompact(clients)} /><StatCard icon={Activity} label={t("totalRequests")} value={formatCompact(requests)} /><StatCard icon={Zap} label={t("totalTokens")} value={formatCompact(tokens)} /><StatCard icon={AlertTriangle} label={t("averageErrorRate")} value={formatPercent(errorRate)} accent={errorRate > 0.1 ? "danger" : errorRate > 0.05 ? "warning" : "default"} /></div>; }
