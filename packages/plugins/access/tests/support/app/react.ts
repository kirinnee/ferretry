import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer, type TestRendererOptions } from 'react-test-renderer';
import { settleUntil } from './settle.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Roots nobody has unmounted yet; `dom-leak-guard.ts` drains this after every test (see `dom.ts`). */
const mountRegistry = globalThis as { __ferretryLiveMounts?: Set<() => Promise<void>> };
mountRegistry.__ferretryLiveMounts ??= new Set();
const liveMounts = mountRegistry.__ferretryLiveMounts;

/** Mounts an element inside `act`, so effects have run by the time it returns. */
export const render = (element: ReactElement, options?: TestRendererOptions): ReactTestRenderer => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, options);
  });
  if (renderer === undefined) throw new Error('the renderer did not mount');
  const mounted = renderer;
  const unmountOnce = mounted.unmount.bind(mounted);
  const cleanup = async (): Promise<void> => {
    liveMounts.delete(cleanup);
    act(() => {
      unmountOnce();
    });
  };
  mounted.unmount = () => {
    liveMounts.delete(cleanup);
    unmountOnce();
  };
  liveMounts.add(cleanup);
  return mounted;
};

/** Runs a callback (an event handler, a state setter) inside `act`. */
export const run = (callback: () => void): void => {
  act(callback);
};

/** Runs asynchronous UI work inside `act`, including promises started by handlers. */
export const runAsync = async (callback: () => Promise<void>): Promise<void> => {
  await act(callback);
};

/**
 * Runs `callback`, then waits for `ready`. A form that digests its answer with `crypto.subtle` crosses a
 * real task boundary that one `await Promise.resolve()` does not wait out, so a test waits for the thing
 * it is about — and fails naming `what` if it never happens.
 */
export const runUntil = async (callback: () => void, ready: () => boolean, what: string): Promise<void> => {
  await runAsync(async () => {
    callback();
  });
  await settleUntil(ready, what, runAsync);
};
