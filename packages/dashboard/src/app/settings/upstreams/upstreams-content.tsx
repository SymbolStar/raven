"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Edit2, ArrowUpDown, Activity, Loader2, Check, Copy, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/components/locale-provider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ProviderPublic,
  CreateProviderInput,
  UpdateProviderInput,
  ProviderFormat,
  UpstreamModelsResponse,
} from "@/lib/types";

interface UpstreamsContentProps {
  providers: ProviderPublic[];
}

export function UpstreamsContent({ providers }: UpstreamsContentProps) {
  const { t } = useLocale();
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4" strokeWidth={1.5} />
          {t("customUpstreamProviders")}
        </h2>
        <CreateProviderDialog />
      </div>

      {providers.length === 0 ? (
        <div className="rounded-card bg-secondary px-6 py-8 text-center">
          <ArrowUpDown className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">{t("noUpstreamProviders")}</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {t("addProviderHint")}
          </p>
        </div>
      ) : (
        <div className="rounded-card bg-secondary overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead><TableHead className="hidden sm:table-cell">{t("format")}</TableHead><TableHead className="hidden lg:table-cell">{t("baseUrl")}</TableHead><TableHead className="hidden md:table-cell">{t("modelPatterns")}</TableHead><TableHead className="hidden xl:table-cell">{t("apiKey")}</TableHead><TableHead>{t("status")}</TableHead><TableHead className="w-24">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="outline" className="text-[10px]">
                      {provider.format}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <code className="text-xs text-muted-foreground truncate max-w-48 block">
                      {provider.base_url}
                    </code>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {provider.model_patterns.length === 0 ? (
                        <span className="text-xs text-muted-foreground">{t("none")}</span>
                      ) : (
                        provider.model_patterns.map((pattern) => (
                          <Badge key={pattern} variant="secondary" className="font-mono text-[10px]">
                            {pattern}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <code className="text-xs text-muted-foreground">{provider.api_key_preview}</code>
                  </TableCell>
                  <TableCell>
                    {provider.is_enabled ? (
                      <Badge variant="success" className="text-[10px]">{t("enabled")}</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">{t("disabled")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <HealthCheckDialog provider={provider} />
                      <EditProviderDialog provider={provider} />
                      <DeleteProviderButton id={provider.id} name={provider.name} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ── Health Check Dialog ──

function HealthCheckDialog({ provider }: { provider: ProviderPublic }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<UpstreamModelsResponse | null>(null);

  // If we already know models endpoint isn't supported, show that immediately
  const notSupported = provider.supports_models_endpoint === false;

  const handleOpen = async (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen && !data && !notSupported) {
      setLoading(true);
      try {
        const res = await fetch(`/api/upstreams/${provider.id}/models`);
        const json = await res.json() as UpstreamModelsResponse;
        setData(json);
      } catch {
        setData({ healthy: false, error: { message: "Network error", type: "network_error" } });
      } finally {
        setLoading(false);
      }
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    setData(null);
    try {
      const res = await fetch(`/api/upstreams/${provider.id}/models`);
      const json = await res.json() as UpstreamModelsResponse;
      setData(json);
    } catch {
      setData({ healthy: false, error: { message: "Network error", type: "network_error" } });
    } finally {
      setLoading(false);
    }
  };

  // Determine if models endpoint is not supported (from provider or from probe result)
  const modelsNotSupported = notSupported || data?.supports_models_endpoint === false;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={t("healthCheck")}>
                <Activity className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("healthCheck")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {provider.name}
            {(notSupported || data) && (
              modelsNotSupported ? (
                <Badge variant="secondary" className="text-[10px]">{t("modelsApiUnavailable")}</Badge>
              ) : data?.healthy ? (
                <Badge variant="success" className="text-[10px]">{t("healthy")}</Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px]">{t("unhealthy")}</Badge>
              )
            )}
          </DialogTitle>
          <DialogDescription>
            {loading ? t("checkingUpstream") : modelsNotSupported ? t("modelsEndpointUnsupported") : data?.healthy ? t("modelsAvailable").replace("{count}", String(data.total)) : t("connectionStatus")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : modelsNotSupported ? (
            <div className="rounded-widget bg-secondary p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t("modelsEndpointUnavailableTitle")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("modelsEndpointUnavailableDescription")}
                  </p>
                </div>
              </div>
            </div>
          ) : data?.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">{t("connectionFailed")}</p>
                  <p className="text-xs text-muted-foreground">{data.error.message}</p>
                </div>
              </div>
            </div>
          ) : data?.models ? (
            <div className="space-y-4">
              {/* Context window warning for local models */}
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {t("localModelContextWarning")}
                    </p>
                  </div>
                </div>
              </div>
              {Object.entries(data.models).map(([owner, models]) => (
                <div key={owner} className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {owner} ({models.length})
                  </h4>
                  <div className="space-y-1">
                    {models.map((model) => (
                      <ModelItem key={model} model={model} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {!modelsNotSupported && (
            <Button variant="outline" onClick={handleRefresh} disabled={loading}>
              {loading ? t("checking") : t("refresh")}
            </Button>
          )}
          <Button onClick={() => setOpen(false)}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Model Item with Copy ──

function ModelItem({ model }: { model: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(model);
      setCopied(true);
      setTimeout(() => setCopied(false), 800);
    } catch {
      // Clipboard API may fail
    }
  };

  return (
    <div className="group flex items-center justify-between rounded-widget bg-secondary px-3 py-1.5">
      <code className="text-xs font-mono truncate">{model}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={handleCopy}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={t("copyModelName")}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" strokeWidth={1.5} />
        ) : (
          <Copy className="h-3 w-3" strokeWidth={1.5} />
        )}
      </Button>
    </div>
  );
}

// ── Create Provider Dialog ──

function CreateProviderDialog() {
  const { t } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<CreateProviderInput>({
    name: "",
    base_url: "",
    format: "anthropic",
    api_key: "",
    model_patterns: [],
    is_enabled: true,
    supports_reasoning: false,
    strict_passthrough: false,
  });

  const handleSubmit = async () => {
    const validationError = validateFormData(formData, false, t);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/upstreams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const data = await res.json();
        const errMsg = typeof data.error === "string"
          ? data.error
          : data.error?.message ?? t("failure");
        setError(errMsg);
        return;
      }

      setOpen(false);
      setFormData({
        name: "",
        base_url: "",
        format: "anthropic",
        api_key: "",
        model_patterns: [],
        is_enabled: true,
        supports_reasoning: false,
        strict_passthrough: false,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("connectionFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          {t("add")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("addUpstreamProvider")}</DialogTitle>
          <DialogDescription>
            {t("addUpstreamDescription")}
          </DialogDescription>
        </DialogHeader>
        <ProviderForm
          data={formData}
          onChange={setFormData}
          error={error}
          onErrorChange={setError}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Provider Dialog ──

function EditProviderDialog({ provider }: { provider: ProviderPublic }) {
  const { t } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<UpdateProviderInput>({
    name: provider.name,
    base_url: provider.base_url,
    format: provider.format,
    model_patterns: provider.model_patterns,
    is_enabled: provider.is_enabled,
    supports_reasoning: provider.supports_reasoning,
    strict_passthrough: provider.strict_passthrough,
  });

  const handleSubmit = async () => {
    const validationError = validateFormData(formData, true, t);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/upstreams/${provider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const data = await res.json();
        const errMsg = typeof data.error === "string"
          ? data.error
          : data.error?.message ?? t("failure");
        setError(errMsg);
        return;
      }

      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("connectionFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label={t("editProvider")}>
          <Edit2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editProvider")}</DialogTitle>
          <DialogDescription>
            {t("editProviderDescription").replace("{name}", provider.name)}
          </DialogDescription>
        </DialogHeader>
        <ProviderForm
          data={formData}
          onChange={setFormData}
          error={error}
          onErrorChange={setError}
          isEdit
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Provider Button ──

function DeleteProviderButton({ id, name }: { id: string; name: string }) {
  const { t } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/upstreams/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(t("failure"));
      setOpen(false);
      router.refresh();
    } catch {
      // Handle error silently
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label={t("deleteProvider")}>
          <Trash2 className="h-3.5 w-3.5 text-destructive" strokeWidth={1.5} />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("deleteProvider")}</DialogTitle>
          <DialogDescription>
            {t("deleteProviderDescription").replace("{name}", name)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={loading}>
            {loading ? t("deleting") : t("deleteProvider")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Provider Form ──

interface ProviderFormProps<T extends CreateProviderInput | UpdateProviderInput> {
  data: T;
  onChange: (data: T) => void;
  error: string | null;
  onErrorChange: (error: string | null) => void;
  isEdit?: boolean;
}

function ProviderForm<T extends CreateProviderInput | UpdateProviderInput>({
  data,
  onChange,
  error,
  onErrorChange,
  isEdit = false,
}: ProviderFormProps<T>) {
  const { t } = useLocale();
  const patternsInput = data.model_patterns?.join(", ") ?? "";

  const handlePatternsChange = (value: string) => {
    onErrorChange(null);
    const patterns = value
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    onChange({ ...data, model_patterns: patterns });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">{t("name")}</Label>
          <Input
            id="name"
            placeholder="e.g. Zhipu GLM"
            value={data.name ?? ""}
            onChange={(e) => {
              onErrorChange(null);
              onChange({ ...data, name: e.target.value });
            }}
            maxLength={100}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="format">{t("format")}</Label>
          <Select
            value={data.format ?? "anthropic"}
            onValueChange={(value: ProviderFormat) => onChange({ ...data, format: value })}
          >
            <SelectTrigger id="format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="base_url">{t("baseUrl")}</Label>
        <Input
          id="base_url"
          placeholder="e.g. https://api.example.com"
          value={data.base_url ?? ""}
          onChange={(e) => {
            onErrorChange(null);
            onChange({ ...data, base_url: e.target.value });
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="api_key">{t("apiKey")} {isEdit && <span className="text-muted-foreground">({t("leaveEmptyKeepCurrent")})</span>}</Label>
        <Input
          id="api_key"
          type="password"
          placeholder={isEdit ? t("updateApiKey") : "sk-..."}
          value={data.api_key ?? ""}
          onChange={(e) => {
            onErrorChange(null);
            const newValue = e.target.value;
            // For edit mode, omit api_key if empty (keep existing)
            // For create mode, always include the value
            if (isEdit && !newValue) {
              // Destructure to remove api_key, then cast back to T
              const { api_key: _apiKey, ...rest } = data;
              onChange(rest as unknown as T);
            } else {
              onChange({ ...data, api_key: newValue } as unknown as T);
            }
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="patterns">{t("modelPatterns")}</Label>
        <Input
          id="patterns"
          placeholder="e.g. glm-5, glm-* (comma-separated)"
          value={patternsInput}
          onChange={(e) => {
            onErrorChange(null);
            handlePatternsChange(e.target.value);
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("exactPatternHelp")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="enabled">{t("enabled")}</Label>
        <Switch
          id="enabled"
          checked={data.is_enabled ?? true}
          onCheckedChange={(checked) => onChange({ ...data, is_enabled: checked })}
        />
      </div>

      {data.format === "anthropic" && (
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="strict_passthrough">{t("strictProtocolPassthrough")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("strictProtocolHelp")}
            </p>
          </div>
          <Switch
            id="strict_passthrough"
            checked={data.strict_passthrough ?? false}
            onCheckedChange={(checked) => onChange({ ...data, strict_passthrough: checked })}
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="supports_reasoning">{t("supportsReasoning")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("supportsReasoningHelp")}
          </p>
        </div>
        <Switch
          id="supports_reasoning"
          checked={data.supports_reasoning ?? false}
          onCheckedChange={(checked) => onChange({ ...data, supports_reasoning: checked })}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ── Validation ──

function validateFormData(
  data: CreateProviderInput | UpdateProviderInput,
  isEdit = false,
  t: (key: "nameRequired" | "nameTooLong" | "baseUrlRequired" | "baseUrlInvalid" | "apiKeyRequired" | "formatInvalid" | "modelPatternRequired" | "modelPatternEmpty") => string,
): string | null {
  if (!data.name?.trim()) {
    return t("nameRequired");
  }
  if (data.name && data.name.length > 100) {
    return t("nameTooLong");
  }
  if (!data.base_url?.trim()) {
    return t("baseUrlRequired");
  }
  try {
    new URL(data.base_url);
  } catch {
    return t("baseUrlInvalid");
  }
  if (!isEdit && !data.api_key?.trim()) {
    return t("apiKeyRequired");
  }
  if (!data.format || (data.format !== "anthropic" && data.format !== "openai")) {
    return t("formatInvalid");
  }
  if (!data.model_patterns || data.model_patterns.length === 0) {
    return t("modelPatternRequired");
  }
  for (const pattern of data.model_patterns) {
    if (!pattern.trim()) {
      return t("modelPatternEmpty");
    }
  }
  return null;
}
