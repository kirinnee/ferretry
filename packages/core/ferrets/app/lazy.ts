/**
 * A component that loads its module on first use, so a half's index holds no view code until a view is drawn.
 *
 * The first draw starts the load and SUSPENDS through React's `use()` on that one cached promise — the suspension
 * protocol React 19 supports. The shell wraps every plugin view in a `<Suspense>` boundary, so only the view's own box
 * shows its loading line until the module arrives; once loaded the same call returns the real component's output, and
 * a load that fails throws the failure for the shell's error boundary.
 *
 * WHY `use()` AND NOT A THROWN PROMISE. React treats a thrown promise as a deprecated suspension. When a view suspends
 * that way while React prerenders what it skipped, React re-tries the view in one retry lane after another for as
 * long as the load is pending. In a browser that re-renders the subtree until the module arrives; inside `act` (every
 * DOM test) React never yields to the event loop between those attempts, so the load can never finish and the test
 * process spins at 100% CPU with no output — what a cold or busy machine saw in
 * `packages/app/tests/integration/real-registry/ferret-page-opens.test.tsx`. `use()` tells React (and `act`) that a
 * promise is pending, so it waits for it instead.
 *
 * Every app half carries this file byte for byte: `scripts/validate/lazy-component-copies.sh` fails on any drift. A
 * half cannot import another package's app files (`context-imports`), and the shell's public API is the whole app
 * barrel, which a half's index must not pull in.
 */

import type { AppComponent } from '@ferretry/kernel/manifest';
import { type ReactPromise, use } from 'react';

/**
 * The load as React's `use()` reads it: a promise that says how it settled (`status`, then `value` or `reason`), so a
 * draw after it settled reads the result at once instead of suspending again for a promise React has not seen. It is
 * written to as it settles, so it is typed loosely here and handed to `use()` as the `ReactPromise` it is.
 */
type TrackedLoad<Props> = Promise<AppComponent<Props>> & {
  status: 'pending' | 'fulfilled' | 'rejected';
  value?: AppComponent<Props>;
  reason?: unknown;
};

export function lazyComponent<Props>(load: () => Promise<AppComponent<Props>>): AppComponent<Props> {
  let loading: TrackedLoad<Props> | undefined;
  return props => {
    if (loading === undefined) {
      const started = Object.assign(load(), { status: 'pending' as const }) as TrackedLoad<Props>;
      started.then(
        component => {
          started.status = 'fulfilled';
          started.value = component;
        },
        reason => {
          started.status = 'rejected';
          started.reason = reason;
        },
      );
      loading = started;
    }
    // Every draw calls `use()` on the one load: it suspends while the load is pending, returns the component once it
    // arrived, and throws a failed load for the shell's error boundary.
    return use(loading as ReactPromise<AppComponent<Props>>)(props);
  };
}
