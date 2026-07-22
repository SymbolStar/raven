"use client";

import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";

export function LanguageToggle() {
  const { locale, setLocale, t } = useLocale();
  const nextLocale = locale === "en" ? "zh-CN" : "en";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setLocale(nextLocale)}
      aria-label={`${t("language")}: ${nextLocale === "en" ? t("english") : t("chinese")}`}
      title={t("language")}
    >
      <Languages className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} />
      <span className="sr-only">{t("language")}</span>
    </Button>
  );
}
