import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";
import { OptimizationsContent } from "./optimizations-content";
import { IPWhitelistContent } from "./ip-whitelist-content";
import { CorsContent } from "./cors-content";
import { SettingsHeader, SettingsOverview } from "./settings-overview";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const settingsResult = await safeFetch<SettingsData>("/api/settings");

  if (!settingsResult.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Settings" }]}>
        <FetchError title="Failed to load settings" message={settingsResult.error} />
      </AppShell>
    );
  }

  const data = settingsResult.data;
  const optEnabled = Object.values(data.optimizations).filter((o) => o.enabled).length;
  const optTotal = Object.keys(data.optimizations).length;
  const stEnabled = Object.values(data.server_tools).filter((t) => t.enabled).length;
  const stTotal = Object.keys(data.server_tools).length;

  return (
    <AppShell breadcrumbs={[{ label: "Settings" }]}>
      <div className="space-y-4 md:space-y-6">
        <SettingsHeader />
        <SettingsOverview
          ipWhitelist={data.ip_whitelist}
          cors={data.cors}
          optimizations={{ enabled: optEnabled, total: optTotal }}
          serverTools={{ enabled: stEnabled, total: stTotal }}
        />

        <IPWhitelistContent data={data.ip_whitelist} />
        <CorsContent data={data.cors} />
        <OptimizationsContent data={data.optimizations} />
      </div>
    </AppShell>
  );
}
