"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/components/locale-provider";
import type { MessageKey } from "@/lib/locale";
import type { OptimizationInfo } from "@/lib/types";

// ── Optimization item definitions ──

const OPTIMIZATION_ITEMS: Array<{
  id: string;
  label: MessageKey;
  description: MessageKey;
}> = [
  {
    id: "sanitize_orphaned_tool_results",
    label: "sanitizeOrphanedToolResults",
    description: "sanitizeOrphanedToolResultsDescription",
  },
  {
    id: "reorder_tool_results",
    label: "reorderToolResults",
    description: "reorderToolResultsDescription",
  },
  {
    id: "filter_whitespace_chunks",
    label: "filterWhitespaceChunks",
    description: "filterWhitespaceChunksDescription",
  },
];

// ── Component ──

interface OptimizationsContentProps {
  data: Record<string, OptimizationInfo>;
}

export function OptimizationsContent({ data }: OptimizationsContentProps) {
  const { t } = useLocale();
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        {t("optimizations")}
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        {t("optimizationsDescription")}
      </p>
      <div className="grid gap-3">
        {OPTIMIZATION_ITEMS.map((item) => {
          const info = data[item.id];
          if (!info) return null;
          return (
            <OptimizationRow
              key={item.id}
              item={item}
              info={info}
            />
          );
        })}
      </div>
    </section>
  );
}

// ── Optimization row ──

function OptimizationRow({
  item,
  info,
}: {
  item: (typeof OPTIMIZATION_ITEMS)[number];
  info: OptimizationInfo;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const [enabled, setEnabled] = useState(info.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      setEnabled(checked);
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: info.key,
            value: checked ? "true" : "false",
          }),
        });
        if (res.ok) {
          router.refresh();
        } else {
          // Revert on failure
          setEnabled(!checked);
          const body = await res.json().catch(() => null);
          const msg =
            body?.error?.message ??
            body?.error ??
            `Save failed (${res.status})`;
          setError(msg);
        }
      } catch (err) {
        setEnabled(!checked);
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [info.key, router],
  );

  return (
    <div className="rounded-card bg-secondary p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label
            htmlFor={`opt-${item.id}`}
            className="text-sm font-medium cursor-pointer"
          >
            {t(item.label)}
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(item.description)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          <Switch
            id={`opt-${item.id}`}
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>
      </div>
      {error && (
        <p className="text-xs text-destructive mt-2">{error}</p>
      )}
    </div>
  );
}
