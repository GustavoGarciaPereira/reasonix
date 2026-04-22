import React, { type ReactNode, createContext, useContext, useEffect, useState } from "react";

/**
 * Global heartbeat for every animated component (braille spinners,
 * elapsed-seconds counters, cursor blink). A single setInterval feeds
 * all of them instead of each component owning one. Consolidating the
 * 5-6 independent timers that used to exist in App.tsx + EventLog.tsx +
 * PromptInput.tsx into one source dramatically cuts the number of
 * React re-renders per second on heavy turns and stops Ink from
 * patching the terminal 30+ times/sec — the main amplifier of redraw
 * artifacts on winpty/MINTTY-class Windows terminals.
 *
 * Resolution: `TICK_MS` (default 120). Components that want 500ms or
 * 1s cadence just modulo the tick counter.
 */
export const TICK_MS = 120;

const TickContext = createContext(0);

export interface TickerProviderProps {
  children: ReactNode;
  /**
   * When true, the provider skips the setInterval entirely — tick stays at
   * 0, all consumers render once and never re-render from the timer. Used
   * by PLAIN_UI mode so the cursor and any surviving spinners don't drive
   * repaints on fragile Windows terminals.
   */
  disabled?: boolean;
}

export function TickerProvider({ children, disabled }: TickerProviderProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (disabled) return;
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, [disabled]);
  return <TickContext.Provider value={tick}>{children}</TickContext.Provider>;
}

/** Current global tick. Re-renders the calling component every `TICK_MS`. */
export function useTick(): number {
  return useContext(TickContext);
}

/**
 * Seconds elapsed since the calling component mounted. Derived from
 * the shared tick + a fresh Date.now() read, so no dedicated timer
 * is needed.
 */
export function useElapsedSeconds(): number {
  const [start] = useState(() => Date.now());
  useTick(); // subscribe to the tick so we re-render
  return Math.floor((Date.now() - start) / 1000);
}
