"use client"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { useLocale } from "@/components/locale-provider"
import type { MessageKey } from "@/lib/locale"

interface ServerToolsContentProps {
  data: Record<string, { enabled: boolean; has_api_key: boolean }>
}

const SERVER_TOOL_ITEMS = [
  {
    id: "web_search",
    label: "webSearch" as MessageKey,
    description: "webSearchDescription" as MessageKey,
    key: "st_web_search_enabled",
    apiKeyKey: "st_web_search_api_key",
  },
]

export function ServerToolsContent({ data }: ServerToolsContentProps) {
  const { t } = useLocale()
  const router = useRouter()
  const webSearch = data.web_search

  const [enabled, setEnabled] = useState(webSearch?.enabled ?? false)
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)

  async function handleToggle(checked: boolean) {
    setEnabled(checked)
    setSaving(true)
    setError(null)

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "st_web_search_enabled", value: checked ? "true" : "false" }),
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

  async function handleSaveKey() {
    if (!apiKey.trim()) {
      setKeyError(t("apiKeyRequired"))
      return
    }

    setSavingKey(true)
    setKeyError(null)

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "st_web_search_api_key", value: apiKey.trim() }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to save API key")
      }

      setApiKey("")
      router.refresh()
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        {t("serverTools")}
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        {t("serverToolsPageDescription")}
      </p>
      <div className="grid gap-3">
        {SERVER_TOOL_ITEMS.map((item) => {
          const itemEnabled = item.id === "web_search" ? enabled : false
          const hasKey = item.id === "web_search" ? (webSearch?.has_api_key ?? false) : false

          return (
            <div
              key={item.id}
              className="rounded-card bg-secondary p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Label htmlFor={`st-${item.id}`} className="text-sm font-medium cursor-pointer">
                    {t(item.label)}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">{t(item.description)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  <Switch
                    id={`st-${item.id}`}
                    checked={itemEnabled}
                    onCheckedChange={handleToggle}
                    disabled={saving}
                  />
                </div>
              </div>
              {error && <p className="text-xs text-destructive mt-2">{error}</p>}

              {/* Expanded config when enabled */}
              {itemEnabled && (
                <div className="mt-4 pt-4 border-t border-border/30">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">{t("apiKey")}</span>
                      {hasKey && !apiKey && (
                        <span className="text-xs text-green-600 flex items-center gap-1">
                          <span className="size-1.5 rounded-full bg-green-600" />
                          {t("configured")}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder={hasKey ? t("updateApiKey") : t("enterTavilyApiKey")}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        disabled={savingKey}
                        className="flex-1 h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveKey}
                        disabled={savingKey || !apiKey.trim()}
                        className="h-8 px-3 text-xs shrink-0"
                      >
                        {savingKey ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          t("save")
                        )}
                      </Button>
                    </div>
                    {keyError && <p className="text-xs text-destructive">{keyError}</p>}
                    {!hasKey && itemEnabled && (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        {t("apiKeyRequiredForSearch")}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("getApiKeyAt")}{" "}
                      <a
                        href="https://tavily.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        tavily.com
                      </a>
                    </p>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
