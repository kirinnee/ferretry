/**
 * The sessions table stops being a useful default below 900px. This crossing
 * is intentionally distinct from the shell's drawer/rail breakpoints: it is
 * about six table columns, not navigation chrome.
 */

import { useEffect, useState } from 'react';

export const DASHBOARD_TABLE_MIN = 900;

/** True when a table would be narrower than its intended presentation. */
export const narrowForWidth = (width: number, breakpoint = DASHBOARD_TABLE_MIN): boolean => width < breakpoint;

const readNarrow = (breakpoint: number): boolean =>
  typeof window === 'undefined' ? false : narrowForWidth(window.innerWidth, breakpoint);

/** Subscribe only to the width crossing rather than every pixel of a resize. */
export function useDashboardNarrow(breakpoint = DASHBOARD_TABLE_MIN): boolean {
  const [narrow, setNarrow] = useState(() => readNarrow(breakpoint));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onCrossing = () => setNarrow(readNarrow(breakpoint));
    query.addEventListener('change', onCrossing);
    onCrossing();
    return () => query.removeEventListener('change', onCrossing);
  }, [breakpoint]);
  return narrow;
}
