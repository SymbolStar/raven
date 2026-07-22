"use client";

import { Clock } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TimeRange } from "@/lib/analytics-filters";
import { useLocale } from "@/components/locale-provider";

const RANGE_OPTIONS = [
  { value: "15m", label: "last15Minutes" },
  { value: "1h", label: "last1Hour" },
  { value: "6h", label: "last6Hours" },
  { value: "24h", label: "last24Hours" },
  { value: "7d", label: "last7Days" },
  { value: "30d", label: "last30Days" },
] as const satisfies ReadonlyArray<{ value: TimeRange; label: "last15Minutes" | "last1Hour" | "last6Hours" | "last24Hours" | "last7Days" | "last30Days" }>;

interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}

export function TimeRangePicker({ value, onChange }: TimeRangePickerProps) {
  const { t } = useLocale();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TimeRange)}>
      <SelectTrigger size="sm" className="text-xs min-w-[150px]">
        <Clock className="size-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGE_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {t(opt.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
