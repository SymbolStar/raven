"use client";

import { Globe, Shield, Sparkles, Wrench } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { StatCard } from "@/components/stats/stat-card";
import type { CorsInfo, IPWhitelistInfo } from "@/lib/types";

export function SettingsHeader() {
  const { t } = useLocale();

  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-display">{t("settings")}</h1>
      <p className="text-meta">{t("settingsDescription")}</p>
    </div>
  );
}

interface SettingsOverviewProps {
  ipWhitelist: IPWhitelistInfo;
  cors: CorsInfo;
  optimizations: { enabled: number; total: number };
  serverTools: { enabled: number; total: number };
}

export function SettingsOverview({ ipWhitelist, cors, optimizations, serverTools }: SettingsOverviewProps) {
  const { t } = useLocale();

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <StatCard
        icon={Shield}
        label={t("ipWhitelist")}
        value={ipWhitelist.enabled ? t("on") : t("off")}
        detail={`${ipWhitelist.ranges.length} ${t(ipWhitelist.ranges.length === 1 ? "range" : "ranges")}`}
        accent={ipWhitelist.enabled ? "success" : "default"}
      />
      <StatCard
        icon={Globe}
        label={t("cors")}
        value={cors.enabled ? t("on") : t("off")}
        detail={`${cors.allowed_origins.length} ${t(cors.allowed_origins.length === 1 ? "origin" : "origins")}`}
        accent={cors.enabled ? "success" : "default"}
      />
      <StatCard icon={Sparkles} label={t("optimizations")} value={`${optimizations.enabled} / ${optimizations.total}`} detail={t("enabled")} />
      <StatCard icon={Wrench} label={t("serverTools")} value={`${serverTools.enabled} / ${serverTools.total}`} detail={t("enabled")} />
    </div>
  );
}
