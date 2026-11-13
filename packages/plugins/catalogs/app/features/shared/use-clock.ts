import { useEffect, useState } from 'react';

/** Starts a repeating call and returns how to stop it. A port, so a suite drives the seconds itself. */
export type Ticker = (onTick: () => void) => () => void;

export const secondTicker: Ticker = onTick => {
  const timer = setInterval(onTick, 1000);
  return () => clearInterval(timer);
};

/** The time, read again every second while `running`. */
export function useClock(now: () => Date, ticker: Ticker, running: boolean): Date {
  const [current, setCurrent] = useState(now);
  useEffect(() => {
    if (!running) return;
    setCurrent(now());
    return ticker(() => setCurrent(now()));
  }, [now, ticker, running]);
  return current;
}
