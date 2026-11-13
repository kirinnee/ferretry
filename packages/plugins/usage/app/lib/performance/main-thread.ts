/**
 * THE MAIN THREAD'S SIDE OF "IT LAGS": long tasks, and how long the main surfaces take to draw.
 *
 * A long task is the browser's own report of the main thread being busy for 50 ms or more, during
 * which a tap or a keystroke waits. Not every browser reports them (Safari does not), so the recorder
 * is told whether they are being observed at all, and a report says "not reported" rather than "none".
 *
 * A render is timed from the moment a surface starts rendering to the layout effect after its commit:
 * a parent's layout effect runs after every child's has, so that span is the whole subtree's render
 * plus the DOM work of committing it. It works in a production build, where React's `<Profiler>`
 * reports nothing.
 */

import { useLayoutEffect, useRef } from 'react';
import type { PerformanceRecorder } from './recorder.ts';

/** The slice of `PerformanceObserver` this needs, so a test can hand one in. */
export interface LongTaskObserverPort {
  readonly supported: boolean;
  readonly observe: (
    callback: (entries: readonly { readonly startTime: number; readonly duration: number }[]) => void,
  ) => () => void;
}

/** The browser's `PerformanceObserver`, or an unsupported port where it has no `longtask` entries. */
export const browserLongTaskObserver = (): LongTaskObserverPort => {
  const Observer = globalThis.PerformanceObserver;
  const supported = Observer?.supportedEntryTypes?.includes('longtask') === true;
  return {
    supported,
    observe: callback => {
      const observer = new Observer(list => callback(list.getEntries()));
      observer.observe({ type: 'longtask', buffered: true });
      return () => observer.disconnect();
    },
  };
};

/** Feeds the browser's long tasks into `recorder` until the returned function is called. */
export const observeLongTasks = (recorder: PerformanceRecorder, port: LongTaskObserverPort): (() => void) => {
  if (!port.supported) return () => undefined;
  recorder.observingLongTasks();
  return port.observe(entries => {
    for (const entry of entries) recorder.recordLongTask(entry.startTime, entry.duration);
  });
};

/**
 * Records how long `surface` took to render and commit, every time it does.
 *
 * `surface` is a fixed name (`fleet`, `session`), never anything about what is on it. A recorder of
 * `undefined` records nothing, so a surface rendered outside the app (a gallery, a test) needs none.
 */
export const useRenderTiming = (recorder: PerformanceRecorder | undefined, surface: string): void => {
  const started = useRef(0);
  started.current = recorder?.clock.now() ?? 0;
  useLayoutEffect(() => {
    if (recorder === undefined) return;
    recorder.recordRender(surface, recorder.clock.now() - started.current);
  });
};
