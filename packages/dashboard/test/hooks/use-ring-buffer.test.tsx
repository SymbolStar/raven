// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useRingBuffer } from "@/hooks/use-ring-buffer";

describe("useRingBuffer", () => {
  it("appends values under capacity", () => {
    const { result } = renderHook(() => useRingBuffer<number>(3));

    act(() => {
      result.current.push(1);
      result.current.push(2);
    });

    expect(result.current.snapshot()).toEqual([1, 2]);
  });

  it("shifts oldest when capacity is exceeded", () => {
    const { result } = renderHook(() => useRingBuffer<number>(3));

    act(() => {
      result.current.push(1);
      result.current.push(2);
      result.current.push(3);
      result.current.push(4);
      result.current.push(5);
    });

    expect(result.current.snapshot()).toEqual([3, 4, 5]);
  });

  it("snapshot returns a fresh copy (not the internal array)", () => {
    const { result } = renderHook(() => useRingBuffer<number>(5));

    act(() => {
      result.current.push(1);
    });
    const a = result.current.snapshot();
    const b = result.current.snapshot();
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
    expect(a).not.toBe(b);

    a.push(99);
    expect(result.current.snapshot()).toEqual([1]);
  });

  it("triggers a rerender on every push", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useRingBuffer<number>(3);
    });

    const before = renders;
    act(() => {
      result.current.push(1);
    });
    act(() => {
      result.current.push(2);
    });
    expect(renders - before).toBe(2);
  });

  it("returns a stable object reference across rerenders (safe as useEffect dep)", () => {
    const { result, rerender } = renderHook(() => useRingBuffer<number>(3));
    const first = result.current;
    rerender();
    const second = result.current;
    expect(second).toBe(first);

    // Even after a push (which causes its own rerender), the identity
    // stays the same — only the snapshot contents change.
    act(() => {
      result.current.push(1);
    });
    const third = result.current;
    expect(third).toBe(first);
    expect(third.push).toBe(first.push);
    expect(third.snapshot).toBe(first.snapshot);
  });
});
