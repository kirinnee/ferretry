import { useEffect, useState } from 'react';

const TICK_MS = 30_000;

/**
 * The wall clock for age labels, re-read every 30 seconds. A local clock, never a daemon read. A `fixed`
 * instant (a test, a screenshot) is returned as given and starts no timer.
 */
export const useNow = (fixed?: number): number => {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
};
