import { ensureDom, interact, mount } from '@ferretry/app/testing';
import type { AppComponent } from '@ferretry/kernel/manifest';
import { describe, expect, it } from 'bun:test';
import { Component, type ReactNode, Suspense } from 'react';
import { lazyComponent } from '../../../app/lazy.ts';

ensureDom();

/** The shell's own shape around a plugin view (`ViewBoundary`): an error boundary around a `<Suspense>`. */
class Boundary extends Component<{ readonly children: ReactNode }, { failed: string | undefined }> {
  override state: { failed: string | undefined } = { failed: undefined };

  static getDerivedStateFromError(error: unknown): { failed: string } {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    if (this.state.failed !== undefined) return <p>failed: {this.state.failed}</p>;
    return <Suspense fallback={<p>loading</p>}>{this.props.children}</Suspense>;
  }
}

/** A plugin component as the shell draws it: an `AppComponent` returns what React draws. */
const drawn = <P,>(component: AppComponent<P>) => component as (props: P) => ReactNode;

/** A module that arrives on a later turn of the event loop, as a chunk does. */
const arriving = <T,>(value: T, ms = 20): Promise<T> => new Promise(resolve => setTimeout(() => resolve(value), ms));

/** A promise the test settles by hand, so a load finishes exactly when the test says and never on a timer. */
const deferred = <T,>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Lets the module arrive and the boundary retry, inside `act`. */
const settle = async (): Promise<void> => await interact(() => arriving(undefined, 40));

describe('lazyComponent', () => {
  it('suspends on the first draw, then draws the real component with its props once the module arrives', async () => {
    const module = deferred<AppComponent<{ readonly name: string }>>();
    const View = drawn(lazyComponent<{ readonly name: string }>(() => module.promise));
    const view = await mount(
      <Boundary>
        <View name="ferret" />
      </Boundary>,
    );
    try {
      expect(view.container.textContent).toBe('loading');
      await interact(() => module.resolve((props: { readonly name: string }) => <p>hello {props.name}</p>));
      expect(view.container.textContent).toBe('hello ferret');
    } finally {
      await view.unmount();
    }
  });

  it('loads once for every draw of the same component', async () => {
    let loads = 0;
    const View = drawn(
      lazyComponent<{ readonly n: number }>(async () => {
        loads += 1;
        return await arriving((props: { readonly n: number }) => <span>{props.n}</span>);
      }),
    );
    const view = await mount(
      <Boundary>
        <View n={1} />
        <View n={2} />
      </Boundary>,
    );
    try {
      await settle();
      expect(view.container.textContent).toBe('12');
      expect(loads).toBe(1);
      await view.render(
        <Boundary>
          <View n={3} />
        </Boundary>,
      );
      expect(view.container.textContent).toBe('3');
      expect(loads).toBe(1);
    } finally {
      await view.unmount();
    }
  });

  it('hands a failed load to the error boundary, and every later draw fails the same way', async () => {
    const View = drawn(
      lazyComponent<object>(async () => {
        await arriving(undefined);
        throw new Error('no such module');
      }),
    );
    const quiet = console.error;
    console.error = () => {};
    try {
      const first = await mount(
        <Boundary>
          <View />
        </Boundary>,
      );
      await settle();
      expect(first.container.textContent).toBe('failed: no such module');
      await first.unmount();
      const again = await mount(
        <Boundary>
          <View />
        </Boundary>,
      );
      expect(again.container.textContent).toBe('failed: no such module');
      await again.unmount();
    } finally {
      console.error = quiet;
    }
  });
});
