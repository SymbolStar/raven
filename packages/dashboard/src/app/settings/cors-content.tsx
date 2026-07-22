"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Globe, Plus, Trash2, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/components/locale-provider";
import type { CorsInfo } from "@/lib/types";

interface CorsContentProps {
  data: CorsInfo;
}

export function CorsContent({ data }: CorsContentProps) {
  const { t } = useLocale();
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [origins, setOrigins] = useState<string[]>(data.allowed_origins);
  const [newOrigin, setNewOrigin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "cors_enabled",
            value: String(checked),
          }),
        });
        if (res.ok) {
          setEnabled(checked);
          router.refresh();
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? body?.error ?? "Failed to save");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  const saveOrigins = useCallback(
    async (newOrigins: string[]) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "cors_allowed_origins",
            value: JSON.stringify(newOrigins),
          }),
        });
        if (res.ok) {
          setOrigins(newOrigins);
          router.refresh();
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? body?.error ?? "Failed to save");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  const handleAddOrigin = useCallback(() => {
    const trimmed = newOrigin.trim();
    if (!trimmed) return;
    let normalized: string;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        setError(t("invalidOriginUrl"));
        return;
      }
      normalized = url.origin;
    } catch {
      setError(t("invalidOriginUrl"));
      return;
    }
    if (origins.includes(normalized)) {
      setError(t("duplicateOrigin"));
      return;
    }
    setNewOrigin("");
    saveOrigins([...origins, normalized]);
  }, [newOrigin, origins, saveOrigins, t]);

  const handleRemoveOrigin = useCallback(
    (index: number) => {
      const newOrigins = origins.filter((_, i) => i !== index);
      saveOrigins(newOrigins);
    },
    [origins, saveOrigins]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddOrigin();
      }
    },
    [handleAddOrigin]
  );

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        {t("corsAllowedOrigins")}
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        {t("corsDescription")}
      </p>

      <div className="rounded-card bg-secondary p-4 space-y-4">
        {/* Enable/Disable toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t("enableCorsRestrictions")}</span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>

        {/* Origins list */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("addAllowedOrigins")}
          </p>

          {/* Existing origins */}
          {origins.length > 0 && (
            <div className="space-y-1.5">
              {origins.map((origin, index) => (
                <div
                  key={origin}
                  className="flex items-center gap-2 rounded bg-background px-3 py-1.5"
                >
                  <code className="flex-1 text-xs font-mono">{origin}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemoveOrigin(index)}
                    disabled={saving}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add new origin */}
          <div className="flex items-center gap-2">
            <Input
              value={newOrigin}
              onChange={(e) => setNewOrigin(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., http://localhost:3000"
              className="flex-1 h-8 text-xs font-mono"
              disabled={saving}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddOrigin}
              disabled={saving || !newOrigin.trim()}
              className="h-8 px-3 text-xs"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              <span className="ml-1.5">{t("add")}</span>
            </Button>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Info notice */}
        <div className="text-xs text-muted-foreground border-t border-border/30 pt-3">
          <p>
            {t("corsEmptyAllowed")}
          </p>
        </div>
      </div>
    </section>
  );
}
