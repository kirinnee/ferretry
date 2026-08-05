/**
 * A real DOM for the shell components that genuinely need one.
 *
 * Focus traps, Escape stacks, pointer-capture swipes and outside-click dismiss
 * are not renderable-tree facts — they are document facts. Asserting them
 * against a shallow tree would test the port's shape and none of its
 * behaviour, so these suites run against happy-dom.
 *
 * Registration is process-wide and idempotent: bun runs the whole suite in one
 * process, and registering twice would replace globals mid-run.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ReactElement } from 'react';
import { act } from 'react';

const registered = globalThis as typeof globalThis & {
  __ferretryDomRegistered?: boolean;
  __ferretryMutationObserverPatched?: boolean;
};
if (!registered.__ferretryDomRegistered) {
  GlobalRegistrator.register({ url: 'https://pwa.example.test/' });
  registered.__ferretryDomRegistered = true;
}

/**
 * happy-dom 20.11.1 keeps its internal MutationObserver delivery closure only
 * through a WeakRef, so an ordinary GC pass can permanently silence a still
 * connected observer. Pin just that orphaned closure while `observe()` builds
 * it; every other WeakRef in the test environment retains its real semantics.
 *
 * TODO: remove after https://github.com/capricorn86/happy-dom/issues/2264 is
 * fixed and the dependency is updated.
 */
if (!registered.__ferretryMutationObserverPatched) {
  class StrongWeakRef<T extends WeakKey> {
    readonly #target: T;

    constructor(target: T) {
      this.#target = target;
    }

    deref(): T {
      return this.#target;
    }
  }

  const originalObserve = MutationObserver.prototype.observe;
  MutationObserver.prototype.observe = function (target: Node, options: MutationObserverInit): void {
    const originalWeakRef = globalThis.WeakRef;
    try {
      globalThis.WeakRef = StrongWeakRef as unknown as typeof WeakRef;
      originalObserve.call(this, target, options);
    } finally {
      globalThis.WeakRef = originalWeakRef;
    }
  };
  registered.__ferretryMutationObserverPatched = true;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');

export interface Mounted {
  readonly container: HTMLElement;
  /** Re-render with new props, inside `act`. */
  readonly render: (element: ReactElement) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

/** Mounts into a fresh container attached to the live document. */
export const mount = async (element: ReactElement): Promise<Mounted> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = async (next: ReactElement): Promise<void> => {
    await act(async () => {
      root.render(next);
    });
  };

  await render(element);

  return {
    container,
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
};

/** Runs a callback (a click, a key press) inside `act` and flushes effects. Any
 *  return value is discarded — `dispatchEvent` answers with a boolean. */
export const interact = async (callback: () => unknown): Promise<void> => {
  await act(async () => {
    await callback();
  });
};

/** Dispatches a trusted-shaped keyboard event at an element. */
export const pressKey = (target: EventTarget, key: string, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
};

/**
 * Narrows away a `null` the DOM cannot promise us, by FAILING rather than by
 * asserting non-null. A missing element is a genuine test failure and deserves
 * to say which one went missing; `!` would surface it as an unrelated
 * `TypeError` several lines later.
 */
export const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};
