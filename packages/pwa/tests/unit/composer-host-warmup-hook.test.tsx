/**
 * The commit handshake itself, asserted on the function the providers are given.
 *
 * The component-level file beside this one proves what a READER sees: no menu
 * ever publishes a ready answer about a family that had already arrived. What it
 * cannot reach is the warm-up's own contract — whether a wait actually ends on a
 * commit, and whether one started before an unmount ever ends at all. Reaching
 * those through the component would need either a production seam existing only
 * for a test, or an assertion on a promise the test made itself, which would
 * pass whether or not the real waiter is stranded.
 *
 * Extracting the hook is what makes them observable honestly: the `warmup`
 * returned here IS the function `createComposerAutocompleteProviders` receives.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  type ComposerHostReadiness,
  type ComposerHostWarmup,
  useComposerHostWarmup,
} from '../../src/lib/composer-host-warmup.ts';
import { render, run, runAsync } from '../support/react.ts';

const renderers: ReactTestRenderer[] = [];

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

/** Microtask turns only — never a timer, so nothing waits on a wall clock. */
const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
};

function WarmupProbe({
  readiness,
  onReady,
}: {
  readonly readiness: ComposerHostReadiness | undefined;
  readonly onReady: (handshake: ComposerHostWarmup) => void;
}) {
  const handshake = useComposerHostWarmup(() => readiness);
  onReady(handshake);
  // Rendered so a commit has something to write; the hook itself paints nothing.
  return <output />;
}

const mountProbe = (
  readiness: ComposerHostReadiness | undefined,
): { readonly view: ReactTestRenderer; readonly handshake: () => ComposerHostWarmup } => {
  let latest: ComposerHostWarmup | undefined;
  const view = render(
    <WarmupProbe
      onReady={handshake => {
        latest = handshake;
      }}
      readiness={readiness}
    />,
  );
  renderers.push(view);
  return {
    view,
    handshake: () => {
      if (latest === undefined) throw new Error('the handshake did not mount');
      return latest;
    },
  };
};

describe('useComposerHostWarmup', () => {
  test('reports nothing to wait for when the host holds no in-flight read', () => {
    // `undefined` is the contract for "already committed whatever it holds", and
    // a caller reads it to answer immediately. An `async` implementation would
    // always hand back a promise here and leave a loaded provider loading.
    expect(
      mountProbe(() => undefined)
        .handshake()
        .warmup(),
    ).toBeUndefined();
    expect(mountProbe(undefined).handshake().warmup()).toBeUndefined();
  });

  test('ends the wait on a commit, not on the settling of the host promise', async () => {
    let settle: () => void = () => undefined;
    const read = new Promise<void>(resolve => {
      settle = resolve;
    });
    const { handshake } = mountProbe(() => read);

    let warmed = false;
    const pending = handshake().warmup();
    if (pending === undefined) throw new Error('an in-flight host read must be waited for');
    void pending.then(() => {
      warmed = true;
    });

    // THE ORDER IS THE CLAIM. The host promise settles here and the microtask
    // queue is drained completely — everything a promise-only wait would need.
    // The warm-up must still be outstanding, because the render publishing the
    // arrived props has not committed yet, and a caller resuming now would
    // re-read the PREVIOUS render's values. That is finding 4 exactly.
    settle();
    await drain();
    expect(warmed).toBe(false);

    // Now let React commit. `act` is what flushes the update the handshake
    // scheduled, and only after that does the wait end.
    await runAsync(drain);
    expect(warmed).toBe(true);
  });

  test('resolves a failed host read rather than propagating it', async () => {
    const { handshake } = mountProbe(() => Promise.reject(new Error('the daemon refused')));

    // "We could not read it" leaves the family unproved, which is the honest
    // state. A rejection here would instead surface as a menu error about a
    // fact the composer never owned.
    const pending = handshake().warmup();
    if (pending === undefined) throw new Error('an in-flight host read must be waited for');
    let warmed = false;
    void pending.then(() => {
      warmed = true;
    });
    await runAsync(drain);
    expect(warmed).toBe(true);
  });

  test('resolves a commit wait that was still parked when the composer unmounted', async () => {
    const { view, handshake } = mountProbe(() => undefined);

    // Parked FIRST and deliberately left pending: no commit is flushed here, so
    // this exact promise is still outstanding when the unmount happens.
    let resolved = false;
    const parked = handshake().nextCommit();
    void parked.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    run(() => view.unmount());
    renderers.splice(renderers.indexOf(view), 1);
    await drain();

    // Cleanup releases the waiters already parked, so THIS promise resolves
    // rather than waiting for a render that can never happen again.
    expect(resolved).toBe(true);
  });

  test('resolves a commit wait requested AFTER the composer unmounted', async () => {
    const { view, handshake } = mountProbe(() => undefined);
    const { nextCommit } = handshake();

    run(() => view.unmount());
    renderers.splice(renderers.indexOf(view), 1);

    // THE FENCE ON THE WAY IN. Releasing at cleanup cannot help a wait that did
    // not exist yet, and this is the ordering a host read settling after
    // navigation produces. It must resolve immediately, leaving the decision
    // about that menu to the provider's own abort fencing.
    let resolved = false;
    void nextCommit().then(() => {
      resolved = true;
    });
    await drain();
    expect(resolved).toBe(true);
  });

  test('resolves a warm-up whose host answered only after the unmount', async () => {
    let settle: () => void = () => undefined;
    const read = new Promise<void>(resolve => {
      settle = resolve;
    });
    const { view, handshake } = mountProbe(() => read);

    let warmed = false;
    const pending = handshake().warmup();
    if (pending === undefined) throw new Error('an in-flight host read must be waited for');
    void pending.then(() => {
      warmed = true;
    });

    // Unmount FIRST, then answer: the warm-up resumes with no mounted composer
    // left to release it, and without the fence it would hang forever.
    run(() => view.unmount());
    renderers.splice(renderers.indexOf(view), 1);
    settle();
    await drain();

    expect(warmed).toBe(true);
  });
});
