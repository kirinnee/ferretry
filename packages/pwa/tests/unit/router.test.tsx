import { afterEach, describe, expect, it } from 'bun:test';

import { RouterProvider, useRouter } from '../../src/lib/router.tsx';
import { interact, mount } from '../support/dom.ts';

function RouterProbe() {
  const { route, navigate } = useRouter();
  const daemonId =
    route.kind === 'connection-picker'
      ? 'none'
      : route.kind === 'legacy-tasks-redirect'
        ? route.to.daemonId
        : route.daemonId;
  return (
    <div>
      <output data-kind={route.kind} data-daemon={daemonId}>
        {route.kind === 'session' ? route.sessionId : route.kind}
      </output>
      <button type="button" onClick={() => navigate('/d/daemon-b/session/shared')}>
        Open shared
      </button>
    </div>
  );
}

const setPath = (path: string): void => window.history.replaceState({}, '', path);

afterEach(() => setPath('/'));

describe('RouterProvider', () => {
  it('reads the daemon-qualified route from the current browser location', async () => {
    setPath('/d/daemon-a/session/one');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    const output = view.container.querySelector('output');
    expect(output?.dataset.kind).toBe('session');
    expect(output?.dataset.daemon).toBe('daemon-a');
    expect(output?.textContent).toBe('one');
    await view.unmount();
  });

  it('pushes an in-app path and updates the rendered route in the same turn', async () => {
    setPath('/d/daemon-a');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    await interact(() => view.container.querySelector('button')?.click());

    const output = view.container.querySelector('output');
    expect(window.location.pathname).toBe('/d/daemon-b/session/shared');
    expect(output?.dataset.kind).toBe('session');
    expect(output?.dataset.daemon).toBe('daemon-b');
    expect(output?.textContent).toBe('shared');
    await view.unmount();
  });

  it('tracks browser back, forward, and other popstate navigation', async () => {
    setPath('/d/daemon-a');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    window.history.pushState({}, '', '/d/daemon-b/settings');
    await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));

    const output = view.container.querySelector('output');
    expect(output?.dataset.kind).toBe('settings');
    expect(output?.dataset.daemon).toBe('daemon-b');
    await view.unmount();
  });

  it('replaces the legacy tasks bookmark with the canonical daemon sessions path', async () => {
    setPath('/d/daemon-a/tasks');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );

    const output = view.container.querySelector('output');
    expect(window.location.pathname).toBe('/d/daemon-a');
    expect(output?.dataset.kind).toBe('sessions');
    expect(output?.dataset.daemon).toBe('daemon-a');
    await view.unmount();
  });

  it('unsubscribes from browser history when the root unmounts', async () => {
    setPath('/d/daemon-a');
    const view = await mount(
      <RouterProvider>
        <RouterProbe />
      </RouterProvider>,
    );
    const rendered = view.container.textContent;

    await view.unmount();
    window.history.pushState({}, '', '/d/daemon-b');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(view.container.textContent).toBe('');
    expect(rendered).toContain('sessions');
  });

  it('fails closed when a consumer is mounted without the app-root provider', async () => {
    await expect(mount(<RouterProbe />)).rejects.toThrow('useRouter must be rendered inside RouterProvider');
  });
});
