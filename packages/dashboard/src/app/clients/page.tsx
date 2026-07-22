import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { safeFetch } from "@/lib/proxy";
import type { BreakdownEntry } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { ClientsTable } from "./clients-table";
import { AnalyticsPageHeader } from "../analytics-page-header";
import { ClientsStats } from "./clients-stats";

export const metadata = { title: "Clients" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ClientsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.csort ?? "count";
  const order = resolvedParams.corder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=client_name&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Clients" }]}>
        <div className="space-y-4 md:space-y-6">
          <AnalyticsPageHeader title="clients" description="clientsDescription" />
          <FetchError title="Failed to load client data" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Clients" }]}>
      <div className="space-y-4 md:space-y-6">
        <AnalyticsPageHeader title="clients" description="clientsDescription" />
        <Suspense>
          <FilterBar compact />
        </Suspense>
        {(() => {
          const totalClients = result.data.length;
          const totalRequests = result.data.reduce((s, e) => s + e.count, 0);
          const totalTokens = result.data.reduce((s, e) => s + e.total_tokens, 0);
          const totalErrors = result.data.reduce(
            (s, e) => s + e.error_rate * e.count,
            0,
          );
          const avgErrorRate =
            totalRequests > 0 ? totalErrors / totalRequests : 0;
          return (
            <ClientsStats clients={totalClients} requests={totalRequests} tokens={totalTokens} errorRate={avgErrorRate} />
          );
        })()}
        <ClientsTable data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}
