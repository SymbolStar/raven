import { describe, it, expect } from "vitest";

import {
  derive401Slices,
  deriveRetryStacks,
  computePercent,
  formatMs,
  formatAge,
} from "@/lib/sentinel-derive";
import type { SentinelCounters, SentinelReasonBuckets } from "@/lib/types";

function emptyBuckets(): SentinelReasonBuckets {
  return { llm401: 0, sentinel401: 0, scheduled: 0, manual: 0 };
}

function emptyCounters(): SentinelCounters {
  return {
    refreshRequested: emptyBuckets(),
    refreshShortCircuit: 0,
    refreshShortCircuitByReason: emptyBuckets(),
    refreshBlockedByCooldown: 0,
    refreshBlockedByCooldownByReason: emptyBuckets(),
    refreshBlockedByMinInterval: 0,
    refreshBlockedByMinIntervalByReason: emptyBuckets(),
    refreshUpstreamCalls: 0,
    refreshUpstreamCallsByReason: emptyBuckets(),
    refreshSucceededTokenUpdated: 0,
    refreshSucceededTokenUpdatedByReason: emptyBuckets(),
    refreshSucceededTokenSame: 0,
    refreshSucceededTokenSameByReason: emptyBuckets(),
    refreshFailed: 0,
    refreshFailedByReason: emptyBuckets(),
    refreshDiscardedStale: 0,
    llm401TokenExpired: 0,
    llm401Other: 0,
    cacheModels401: 0,
    probingEntered: 0,
  };
}

describe("sentinel-derive", () => {
  describe("derive401Slices", () => {
    it("returns three slices with zero values from empty counters", () => {
      const slices = derive401Slices(emptyCounters());
      expect(slices).toHaveLength(3);
      expect(slices.map((s) => s.key)).toEqual(["expired", "other", "cacheModels"]);
      expect(slices.every((s) => s.value === 0)).toBe(true);
    });

    it("maps counters to slices with correct colors", () => {
      const c = emptyCounters();
      c.llm401TokenExpired = 7;
      c.llm401Other = 2;
      c.cacheModels401 = 1;
      const slices = derive401Slices(c);
      expect(slices[0]!.value).toBe(7);
      expect(slices[1]!.value).toBe(2);
      expect(slices[2]!.value).toBe(1);
      expect(slices[0]!.color).toContain("chart-");
      expect(slices[1]!.color).toContain("chart-");
      expect(slices[2]!.color).toContain("chart-");
    });
  });

  describe("deriveRetryStacks", () => {
    it("returns six zero segments with total=0 on empty input", () => {
      const r = deriveRetryStacks(emptyCounters());
      expect(r.total).toBe(0);
      expect(r.segments).toHaveLength(6);
      expect(r.segments.every((s) => s.value === 0)).toBe(true);
    });

    it("ignores non-llm401 reasons in by-reason counters", () => {
      const c = emptyCounters();
      c.refreshSucceededTokenUpdatedByReason = {
        llm401: 3,
        sentinel401: 0,
        scheduled: 99, // background work — must NOT inflate retry stack
        manual: 0,
      };
      const r = deriveRetryStacks(c);
      const refreshed = r.segments.find((s) => s.key === "refreshed");
      expect(refreshed?.value).toBe(3);
      expect(r.total).toBe(3);
    });

    it("sums all six llm401 by-reason buckets into total", () => {
      const c = emptyCounters();
      c.refreshSucceededTokenUpdatedByReason.llm401 = 1;
      c.refreshSucceededTokenSameByReason.llm401 = 2;
      c.refreshFailedByReason.llm401 = 3;
      c.refreshShortCircuitByReason.llm401 = 4;
      c.refreshBlockedByCooldownByReason.llm401 = 5;
      c.refreshBlockedByMinIntervalByReason.llm401 = 6;
      const r = deriveRetryStacks(c);
      expect(r.total).toBe(21);
    });
  });

  describe("computePercent", () => {
    it("returns 0 when total is 0 (no division by zero)", () => {
      expect(computePercent(5, 0)).toBe(0);
    });

    it("floors fractional percentages", () => {
      // 1/3 = 33.33… → 33
      expect(computePercent(1, 3)).toBe(33);
      // 2/3 = 66.66… → 66
      expect(computePercent(2, 3)).toBe(66);
    });

    it("returns 100 for whole", () => {
      expect(computePercent(7, 7)).toBe(100);
    });

    it("returns 0 for negative or zero part", () => {
      expect(computePercent(0, 10)).toBe(0);
      expect(computePercent(-1, 10)).toBe(0);
    });
  });

  describe("formatMs", () => {
    it("returns dash for non-positive", () => {
      expect(formatMs(0)).toBe("—");
      expect(formatMs(-1)).toBe("—");
    });

    it("formats sub-second as ms, then s, then m", () => {
      expect(formatMs(500)).toBe("500ms");
      expect(formatMs(5_500)).toBe("5.5s");
      expect(formatMs(120_000)).toBe("2.0m");
    });
  });

  describe("formatAge", () => {
    it("returns dash for falsy timestamp", () => {
      expect(formatAge(0)).toBe("—");
    });

    it("returns 'now' for future timestamps", () => {
      const now = 1_000_000_000_000;
      expect(formatAge(now + 5_000, now)).toBe("now");
    });

    it("formats across s / m / h boundaries", () => {
      const now = 1_000_000_000_000;
      expect(formatAge(now - 30_000, now)).toBe("30s ago");
      expect(formatAge(now - 120_000, now)).toBe("2m ago");
      expect(formatAge(now - 7_200_000, now)).toBe("2h ago");
    });
  });
});
