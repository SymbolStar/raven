"use client";

import { useLocale } from "@/components/locale-provider";
import type { MessageKey } from "@/lib/locale";

export function SettingsSubpageHeader({ title, description }: { title: MessageKey; description: MessageKey }) {
  const { t } = useLocale();
  return <div className="flex flex-col gap-1"><h1 className="text-display">{t(title)}</h1><p className="text-meta">{t(description)}</p></div>;
}
