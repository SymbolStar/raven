"use client";

import { useState } from "react";
import { Settings2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import type { MessageKey } from "@/lib/locale";

export interface ColumnDef {
  key: string;
  label: MessageKey;
  defaultVisible: boolean;
}

/** All available columns for the request table. */
export const ALL_COLUMNS: ColumnDef[] = [
  { key: "timestamp", label: "time", defaultVisible: true },
  { key: "model", label: "model", defaultVisible: true },
  { key: "status", label: "status", defaultVisible: true },
  { key: "latency_ms", label: "latency", defaultVisible: true },
  { key: "ttft_ms", label: "ttft", defaultVisible: true },
  { key: "tokens", label: "totalTokens", defaultVisible: true },
  { key: "stream", label: "stream", defaultVisible: true },
  { key: "path", label: "path", defaultVisible: true },
  // Extended columns (hidden by default)
  { key: "client_format", label: "format", defaultVisible: false },
  { key: "strategy", label: "strategy", defaultVisible: false },
  { key: "upstream", label: "upstream", defaultVisible: false },
  { key: "account_name", label: "account", defaultVisible: false },
  { key: "client_name", label: "client", defaultVisible: false },
  { key: "session_id", label: "session", defaultVisible: false },
  { key: "status_code", label: "statusCode", defaultVisible: false },
  { key: "processing_ms", label: "processing", defaultVisible: false },
  { key: "stop_reason", label: "stopReason", defaultVisible: false },
  { key: "tool_call_count", label: "toolCalls", defaultVisible: false },
  { key: "routing_path", label: "routing", defaultVisible: false },
  { key: "translated_model", label: "translatedModel", defaultVisible: false },
  { key: "error_message", label: "failure", defaultVisible: false },
];

export function getDefaultVisibleColumns(): Set<string> {
  return new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));
}

interface ColumnConfigProps {
  visibleColumns: Set<string>;
  onToggle: (key: string) => void;
}

export function ColumnConfig({ visibleColumns, onToggle }: ColumnConfigProps) {
  const [open, setOpen] = useState(false);
  const { t } = useLocale();

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-label={t("configureColumns")}
        aria-expanded={open}
      >
        <Settings2 className="size-3.5 mr-1.5" />
        {t("columns")}
      </Button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border bg-popover p-1 shadow-md">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {t("toggleColumns")}
            </div>
            {ALL_COLUMNS.map((col) => (
              <button type="button"
                key={col.key}
                onClick={() => onToggle(col.key)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors"
                role="menuitemcheckbox"
                aria-checked={visibleColumns.has(col.key)}
              >
                <span className="size-3.5 flex items-center justify-center">
                  {visibleColumns.has(col.key) && <Check className="size-3" />}
                </span>
                {t(col.label)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
