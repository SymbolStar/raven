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
import { SessionsTable } from "./sessions-table";
import { SessionsHeader } from "./sessions-header";
import { SessionsStats } from "./sessions-stats";

export const metadata = { title: "Sessions" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function SessionsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.ssort ?? "last_seen";
  const order = resolvedParams.sorder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=session_id&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Sessions" }]}>
        <div className="space-y-4 md:space-y-6">
          <SessionsHeader />
          <FetchError title="Failed to load session data" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Sessions" }]}>
      <div className="space-y-4 md:space-y-6">
        <SessionsHeader />
        <Suspense>
          <FilterBar compact />
        </Suspense>
        {(() => {
          const totalSessions = result.data.length;
          const totalRequests = result.data.reduce((s, e) => s + e.count, 0);
          const totalTokens = result.data.reduce((s, e) => s + e.total_tokens, 0);
          // Avg session duration = mean of (last_seen - first_seen) per session.
          const avgDurationMs =
            totalSessions > 0
              ? result.data.reduce(
                  (s, e) => s + Math.max(0, e.last_seen - e.first_seen),
                  0,
                ) / totalSessions
              : 0;
          return <SessionsStats totalSessions={totalSessions} totalRequests={totalRequests} totalTokens={totalTokens} averageDurationMs={avgDurationMs} />;
        })()}
        <SessionsTable data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}
