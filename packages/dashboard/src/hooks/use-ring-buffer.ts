import { useCallback, useReducer, useRef } from "react";

export interface RingBuffer<T> {
  /** Append a value; drops oldest if over capacity. Triggers a rerender. */
  push: (value: T) => void;
  /** Returns the current contents (oldest → newest). New array each call. */
  snapshot: () => T[];
}

/**
 * Bounded FIFO buffer that integrates with React rerender on mutation.
 *
 * Storage lives in a `useRef` so push is O(1) and does not allocate. A
 * `useReducer` counter is bumped on each push to schedule a rerender, so
 * consumers can call `snapshot()` to read the latest contents from the
 * render body.
 */
export function useRingBuffer<T>(maxLen: number): RingBuffer<T> {
  const ref = useRef<T[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const push = useCallback(
    (value: T) => {
      const arr = ref.current;
      arr.push(value);
      if (arr.length > maxLen) {
        arr.splice(0, arr.length - maxLen);
      }
      bump();
    },
    [maxLen],
  );

  const snapshot = useCallback(() => ref.current.slice(), []);

  return { push, snapshot };
}
