"use client";

import { useLocale } from "@/components/locale-provider";

export function SessionsHeader() {
  const { t } = useLocale();
  return <div className="flex flex-col gap-1"><h1 className="text-display">{t("sessions")}</h1><p className="text-meta">{t("sessionsDescription")}</p></div>;
}
