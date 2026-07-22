"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";
import { useLocale } from "@/components/locale-provider";
import type { MessageKey } from "@/lib/locale";

interface ModelExplorerProps {
  data: BreakdownEntry[];
  currentSort: string;
  currentOrder: string;
}

const COLUMNS = [
  { key: "key", label: "model", sortable: false }, { key: "count", label: "requests", sortable: true }, { key: "total_tokens", label: "totalTokens", sortable: true }, { key: "input_tokens", label: "input", sortable: true }, { key: "output_tokens", label: "output", sortable: true }, { key: "avg_latency_ms", label: "averageLatency", sortable: true }, { key: "p95_latency_ms", label: "p95Latency", sortable: true }, { key: "avg_ttft_ms", label: "averageTtft", sortable: true }, { key: "error_rate", label: "errorRate", sortable: true }, { key: "last_seen", label: "lastSeen", sortable: true },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey; sortable: boolean }>;

function formatRelativeTime(epoch: number, t: (key: "justNow" | "minutesAgo" | "hoursAgo" | "daysAgo") => string): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return t("justNow"); if (diff < 3600000) return `${Math.floor(diff / 60000)}${t("minutesAgo")}`; if (diff < 86400000) return `${Math.floor(diff / 3600000)}${t("hoursAgo")}`; return `${Math.floor(diff / 86400000)}${t("daysAgo")}`;
}

function formatCellValue(entry: BreakdownEntry, key: string, t: (key: "justNow" | "minutesAgo" | "hoursAgo" | "daysAgo") => string): string {
  switch (key) {
    case "key":
      return entry.key || "(unknown)";
    case "count":
      return formatCompact(entry.count);
    case "total_tokens":
      return formatCompact(entry.total_tokens);
    case "input_tokens":
      return formatCompact(entry.input_tokens);
    case "output_tokens":
      return formatCompact(entry.output_tokens);
    case "avg_latency_ms":
      return formatLatency(entry.avg_latency_ms);
    case "p95_latency_ms":
      return formatLatency(entry.p95_latency_ms);
    case "avg_ttft_ms":
      return entry.avg_ttft_ms != null ? formatLatency(entry.avg_ttft_ms) : "—";
    case "error_rate":
      return formatPercent(entry.error_rate);
    case "last_seen":
      return formatRelativeTime(entry.last_seen, t);
    default:
      return "";
  }
}

export function ModelExplorer({ data, currentSort, currentOrder }: ModelExplorerProps) {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const toggleSort = useCallback(
    (col: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (currentSort === col) {
        params.set("morder", currentOrder === "desc" ? "asc" : "desc");
      } else {
        params.set("msort", col);
        params.set("morder", "desc");
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [currentSort, currentOrder, searchParams, router, pathname],
  );

  return (
    <div className="bg-secondary rounded-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-left text-card-label font-medium whitespace-nowrap"
                >
                  {col.sortable ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1 -ml-1.5"
                      onClick={() => toggleSort(col.key)}
                    >
                      {t(col.label)}
                      {currentSort === col.key ? (
                        currentOrder === "desc" ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUp className="size-3" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </Button>
                  ) : (
                    t(col.label)
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((entry) => (
              <tr
                key={entry.key}
                className="border-b border-border/50 hover:bg-background/50 transition-colors"
              >
                {COLUMNS.map((col) => (
                  <td
                    key={col.key}
                    className="px-3 py-2.5 whitespace-nowrap tabular-nums"
                  >
                    {col.key === "key" ? (
                      <span className="font-medium text-foreground">{entry.key || t("unknown")}</span>
                    ) : col.key === "error_rate" ? (
                      <Badge
                        variant={entry.error_rate > 0.1 ? "destructive" : entry.error_rate > 0.05 ? "warning" : "secondary"}
                        className="text-[10px] px-1.5"
                      >
                        {formatCellValue(entry, col.key, t)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{formatCellValue(entry, col.key, t)}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                  {t("noModelData")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
