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
import { ModelExplorer } from "./model-explorer";
import { AnalyticsPageHeader } from "../analytics-page-header";
import { ModelsStats } from "./models-stats";

export const metadata = { title: "Models" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ModelsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.msort ?? "count";
  const order = resolvedParams.morder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=model&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Models" }]}>
        <div className="space-y-4 md:space-y-6">
          <AnalyticsPageHeader title="modelExplorer" description="modelExplorerDescription" />
          <FetchError title="Failed to load model stats" message={result.error} />
        </div>
      </AppShell>
    );
  }

  const models = result.data.map((e) => e.key).filter(Boolean);

  // Aggregate summary cards from existing BreakdownEntry data — no extra API call.
  const totalModels = result.data.length;
  const totalRequests = result.data.reduce((s, e) => s + e.count, 0);
  const totalTokens = result.data.reduce((s, e) => s + e.total_tokens, 0);
  const totalErrors = result.data.reduce(
    (s, e) => s + e.error_rate * e.count,
    0,
  );
  const avgErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

  return (
    <AppShell breadcrumbs={[{ label: "Models" }]}>
      <div className="space-y-4 md:space-y-6">
        <AnalyticsPageHeader title="modelExplorer" description="modelExplorerDescription" />
        <Suspense>
          <FilterBar models={models} compact />
        </Suspense>
        <ModelsStats models={totalModels} requests={totalRequests} tokens={totalTokens} errorRate={avgErrorRate} />
        <ModelExplorer data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}
