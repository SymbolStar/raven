"use client"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useLocale } from "@/components/locale-provider"

interface DebugInfo {
  enabled: boolean
  key: string
}

interface DebugContentProps {
  data: Record<string, DebugInfo>
}

export function DebugContent({ data }: DebugContentProps) {
  const { t } = useLocale()
  const info = data.tool_call_debug

  if (!info) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("debugNotAvailable")}
      </p>
    )
  }

  return <DebugContentBody info={info} />
}

function DebugContentBody({ info }: { info: DebugInfo }) {
  const { t } = useLocale()
  const router = useRouter()
  const key = info.key
  const [enabled, setEnabled] = useState(info.enabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleToggle(checked: boolean) {
    setEnabled(checked)
    setSaving(true)
    setError(null)

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: checked ? "true" : "false" }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to update setting")
      }

      router.refresh()
    } catch (err) {
      setEnabled(!checked)
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        {t("debugging")}
      </h2>
      <div className="grid gap-3">
        {[{ id: "tool_call_debug" }].map((item) => (
          <div
            key={item.id}
            className="rounded-card bg-secondary p-4"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <Label
                  htmlFor={`debug-${item.id}`}
                  className="text-sm font-medium cursor-pointer"
                >
                  {t("toolCallDebug")}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">{t("toolCallDebugDescription")}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                <Switch
                  id={`debug-${item.id}`}
                  checked={enabled}
                  onCheckedChange={handleToggle}
                  disabled={saving}
                />
              </div>
            </div>
            {error && <p className="text-xs text-destructive mt-2">{error}</p>}
          </div>
        ))}
      </div>
    </section>
  )
}
