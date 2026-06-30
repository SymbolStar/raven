// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { SentinelStatusPanel } from "@/app/sentinel-status-panel";
import type {
  SentinelStatus,
  SentinelReasonBuckets,
} from "@/lib/types";

function emptyBuckets(): SentinelReasonBuckets {
  return { llm401: 0, sentinel401: 0, scheduled: 0, manual: 0 };
}

function buildStatus(overrides: Partial<SentinelStatus> = {}): SentinelStatus {
  return {
    generation: 1,
    mode: "steady",
    cooldownRemainingMs: 0,
    consecutiveFailures: 0,
    forceSteadyAfterCooldown: false,
    lastRefreshInSeconds: 1500,
    lastSuccessAt: Date.now(),
    hasInflight: false,
    pendingTimer: true,
    signalScore: 0,
    counters: {
      refreshRequested: { llm401: 0, sentinel401: 0, scheduled: 1, manual: 0 },
      refreshShortCircuit: 0,
      refreshShortCircuitByReason: emptyBuckets(),
      refreshBlockedByCooldown: 0,
      refreshBlockedByCooldownByReason: emptyBuckets(),
      refreshBlockedByMinInterval: 0,
      refreshBlockedByMinIntervalByReason: emptyBuckets(),
      refreshUpstreamCalls: 1,
      refreshUpstreamCallsByReason: { llm401: 0, sentinel401: 0, scheduled: 1, manual: 0 },
      refreshSucceededTokenUpdated: 1,
      refreshSucceededTokenUpdatedByReason: { llm401: 0, sentinel401: 0, scheduled: 1, manual: 0 },
      refreshSucceededTokenSame: 0,
      refreshSucceededTokenSameByReason: emptyBuckets(),
      refreshFailed: 0,
      refreshFailedByReason: emptyBuckets(),
      refreshDiscardedStale: 0,
      llm401TokenExpired: 0,
      llm401Other: 0,
      cacheModels401: 0,
      probingEntered: 0,
    },
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SentinelStatusPanel", () => {
  it("renders three panels with section title", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus(),
    } as Response);

    render(<SentinelStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText("Token Refresh Sentinel")).toBeTruthy();
    });
    expect(screen.getByText("401 Occurrences")).toBeTruthy();
    expect(screen.getByText("LLM-401 Auto Retry")).toBeTruthy();
    expect(screen.getByText("Live State")).toBeTruthy();
  });

  it("shows STEADY badge in default healthy state", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus(),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText("STEADY")).toBeTruthy();
    });
  });

  it("shows PROBING badge when mode is probing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus({ mode: "probing", signalScore: 5 }),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText("PROBING")).toBeTruthy();
    });
  });

  it("shows OFFLINE badge when mode is null", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus({ mode: null }),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText("OFFLINE")).toBeTruthy();
    });
  });

  it("renders error message on fetch failure (no initial data)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeTruthy();
    });
  });

  it("renders Loading on first paint when no initialData", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SentinelStatusPanel />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("uses initialData immediately without waiting for fetch", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SentinelStatusPanel initialData={buildStatus()} />);
    expect(screen.getByText("STEADY")).toBeTruthy();
  });

  it("displays 401 counters", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        buildStatus({
          counters: {
            ...buildStatus().counters,
            llm401TokenExpired: 3,
            llm401Other: 1,
            cacheModels401: 0,
            refreshSucceededTokenUpdated: 3,
          },
        }),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      // Total LLM 401 = 3 + 1 = 4
      expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    });
  });

  it("LLM-401 panel uses by-reason counters (does NOT count scheduled refresh as auto-retry)", async () => {
    // Background scheduled refresh succeeded 5 times — must NOT show up as
    // "Refreshed → Retry". Only an llm-401-triggered refresh should.
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(
      <SentinelStatusPanel
        initialData={buildStatus({
          counters: {
            ...buildStatus().counters,
            // Aggregate happens to be large from background activity
            refreshSucceededTokenUpdated: 7,
            refreshSucceededTokenUpdatedByReason: {
              llm401: 2,         // Only the user-experience path
              sentinel401: 0,
              scheduled: 5,      // Background — should NOT inflate LLM panel
              manual: 0,
            },
            refreshFailedByReason: emptyBuckets(),
          },
        })}
      />,
    );

    // "Refreshed → Retry" cell shows 2 (llm-401 only), not 7
    const refreshedCell = screen.getByText("Refreshed → Retry").parentElement;
    expect(refreshedCell?.textContent).toContain("2");
    // And the Live State panel's "Background OK" reflects the scheduled work
    const bgCell = screen.getByText("Background OK").parentElement;
    expect(bgCell?.textContent).toContain("5");
  });

  it("formats cooldown across ms / s / m ranges", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    const { unmount: u1 } = render(
      <SentinelStatusPanel initialData={buildStatus({ cooldownRemainingMs: 500 })} />,
    );
    expect(screen.getByText("500ms")).toBeTruthy();
    u1();

    const { unmount: u2 } = render(
      <SentinelStatusPanel initialData={buildStatus({ cooldownRemainingMs: 5_500 })} />,
    );
    expect(screen.getByText("5.5s")).toBeTruthy();
    u2();

    render(
      <SentinelStatusPanel initialData={buildStatus({ cooldownRemainingMs: 120_000 })} />,
    );
    expect(screen.getByText("2.0m")).toBeTruthy();
  });

  it("formats lastSuccess age across s / m / h ranges", () => {
    const now = Date.now();
    fetchMock.mockReturnValue(new Promise(() => {}));

    // Seconds
    const { unmount: u1 } = render(
      <SentinelStatusPanel initialData={buildStatus({ lastSuccessAt: now - 30_000 })} />,
    );
    expect(screen.getByText(/\d+s ago/)).toBeTruthy();
    u1();

    // Minutes
    const { unmount: u2 } = render(
      <SentinelStatusPanel initialData={buildStatus({ lastSuccessAt: now - 120_000 })} />,
    );
    expect(screen.getByText(/\d+m ago/)).toBeTruthy();
    u2();

    // Hours
    const { unmount: u3 } = render(
      <SentinelStatusPanel initialData={buildStatus({ lastSuccessAt: now - 7_200_000 })} />,
    );
    expect(screen.getByText(/\d+h ago/)).toBeTruthy();
    u3();

    // Missing timestamp → "—"
    render(<SentinelStatusPanel initialData={buildStatus({ lastSuccessAt: 0 })} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("handles fetch returning non-ok response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    });
  });
});
