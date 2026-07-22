"use client";

import { useLocale } from "@/components/locale-provider";

export function OverviewHeader() {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-display">{t("overview")}</h1>
      <p className="text-meta">{t("overviewDescription")}</p>
    </div>
  );
}
