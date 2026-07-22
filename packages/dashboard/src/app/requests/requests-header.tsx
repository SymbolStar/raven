"use client";

import { useLocale } from "@/components/locale-provider";

export function RequestsHeader() {
  const { t } = useLocale();
  return <div className="flex flex-col gap-1"><h1 className="text-display">{t("requests")}</h1><p className="text-meta">{t("requestsDescription")}</p></div>;
}
