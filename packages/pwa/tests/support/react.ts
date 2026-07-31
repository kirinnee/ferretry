import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer, type TestRendererOptions } from 'react-test-renderer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts an element inside `act`, so effects have run by the time it returns. */
export const render = (element: ReactElement, options?: TestRendererOptions): ReactTestRenderer => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, options);
  });
  if (renderer === undefined) throw new Error('the renderer did not mount');
  return renderer;
};

/** Runs a callback (an event handler, a state setter) inside `act`. */
export const run = (callback: () => void): void => {
  act(callback);
};

/** Runs asynchronous UI work inside `act`, including promises started by handlers. */
export const runAsync = async (callback: () => Promise<void>): Promise<void> => {
  await act(callback);
};
