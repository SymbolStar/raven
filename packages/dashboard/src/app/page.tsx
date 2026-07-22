import { Suspense } from "react";
import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { AnalyticsCharts } from "./analytics-charts";
import { SentinelStatusPanel } from "./sentinel-status-panel";
import { safeFetch } from "@/lib/proxy";
import type { SummaryStats, ExtendedTimeseriesBucket, BreakdownEntry, Percentiles } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
  rangeToInterval,
} from "@/lib/analytics-filters";
import { OverviewHeader } from "./overview-header";
import { OverviewStats } from "./overview-stats";

export const metadata: Metadata = { title: "Overview" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  // Parse filters from URL
  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const interval = rangeToInterval(filters.range);

  // Fetch all data in parallel
  const [summaryResult, timeseriesResult, p95Result, modelBkResult, clientBkResult, strategyBkResult] =
    await Promise.all([
      safeFetch<SummaryStats>(`/api/stats/summary${apiQuery}`),
      safeFetch<ExtendedTimeseriesBucket[]>(
        `/api/stats/timeseries${apiQuery}${apiQuery ? "&" : "?"}interval=${interval}`,
      ),
      safeFetch<Percentiles>(`/api/stats/percentiles${apiQuery}${apiQuery ? "&" : "?"}metric=latency_ms`),
      safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=model&limit=5&sort=count&order=desc`),
      safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=client_name&limit=5&sort=count&order=desc`),
      safeFetch<BreakdownEntry[]>(`/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=strategy&limit=5&sort=count&order=desc`),
    ]);

  if (!summaryResult.ok) {
    return (
      <AppShell>
        <FetchError title="Failed to load dashboard" message={summaryResult.error} />
      </AppShell>
    );
  }

  const summary = summaryResult.data;
  const timeseries = timeseriesResult.ok ? timeseriesResult.data : [];
  const p95 = p95Result.ok ? p95Result.data : null;
  const modelBreakdown = modelBkResult.ok ? modelBkResult.data : [];
  const clientBreakdown = clientBkResult.ok ? clientBkResult.data : [];
  const strategyBreakdown = strategyBkResult.ok ? strategyBkResult.data : [];

  // Extract models list for filter dropdown
  const models = modelBreakdown.map((e) => e.key).filter(Boolean);
  const strategies = strategyBreakdown.map((e) => e.key).filter(Boolean);

  // Sparkline data from timeseries buckets
  const requestsSpark = timeseries.map((b) => b.count);
  const tokensSpark = timeseries.map((b) => b.total_tokens);
  const latencySpark = timeseries.map((b) => b.avg_latency_ms);

  return (
    <AppShell>
      <div className="space-y-5 md:space-y-7">
        {/* Page header */}
        <OverviewHeader />

        {/* Filter Bar */}
        <Suspense>
          <FilterBar models={models} strategies={strategies} />
        </Suspense>

        {/* Stat cards row */}
        <OverviewStats summary={summary} p95={p95} requestsSpark={requestsSpark} tokensSpark={tokensSpark} latencySpark={latencySpark} />

        {/* Analytics charts */}
        <AnalyticsCharts
          timeseries={timeseries}
          modelBreakdown={modelBreakdown}
          clientBreakdown={clientBreakdown}
          strategyBreakdown={strategyBreakdown}
        />

        {/* Token refresh sentinel — observability for the 401 auto-retry path */}
        <SentinelStatusPanel />
      </div>
    </AppShell>
  );
}
