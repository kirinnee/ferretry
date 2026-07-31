import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts an element inside `act`, so effects have run by the time it returns. */
export const render = (element: ReactElement): ReactTestRenderer => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element);
  });
  if (renderer === undefined) throw new Error('the renderer did not mount');
  return renderer;
};

/** Runs a callback (an event handler, a state setter) inside `act`. */
export const run = (callback: () => void): void => {
  act(callback);
};
