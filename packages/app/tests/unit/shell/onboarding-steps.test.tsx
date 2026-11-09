import { afterEach, describe, expect, test } from 'bun:test';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * S14: FIRST RUN REACHES ONBOARDING, AND ITS STEPS COME FROM THE PLUGINS. Booted over the real, generated registry:
 * with no daemon paired the first-run page is Onboarding's daemon-less screen; on a machine, Onboarding's own `steps`
 * screen offers the `onboarding.step` slot, and every plugin that declared a step reaches it with a panel.
 */

const ids = ['onboarding', 'claude-code', 'codex', 'logins', 'runtimes', 'shells'] as const;
const real = ids.map(id => generated.surfaces.find(entry => entry.id === id) as SurfaceEntry);
const surfaces: SurfaceEntry[] = [...CORE, ...real];

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const go = (path: string): void => window.history.replaceState(null, '', path);
afterEach(() => go('/'));

async function until(done: () => boolean, turns = 300): Promise<void> {
  for (let turn = 0; turn < turns && !done(); turn += 1) {
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
  }
}

/** The steps the daemon lists: exactly the ones the five plugins declare in their manifests. */
const declaredSteps = real.flatMap(entry =>
  (entry.manifest.onboarding ?? []).map(step => ({
    plugin: entry.id,
    id: step.id,
    title: step.title,
    order: step.order,
    state: 'pending' as const,
  })),
);

function boot(options: { paired: boolean; steps?: typeof declaredSteps }) {
  const answered: string[] = [];
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/onboarding')
      return json({ steps: options.steps ?? declaredSteps, complete: false, setUp: false });
    if (request.path.startsWith('/v1/onboarding/steps/')) {
      answered.push(`${request.method} ${request.path} ${JSON.stringify(request.body)}`);
      const [plugin, id] = request.path.split('/').slice(-2);
      return json({ plugin, id, title: 't', order: 1, state: 'done' });
    }
    return json({ error: 'none', code: 'not_found' }, 404);
  });
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  if (options.paired)
    daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  const ports = { daemons } as unknown as DaemonlessPorts;
  const registered = registeredDaemonless(real, ports);
  expect(registered.failures).toEqual([]);
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async () => transport,
    daemonless: { views: registered.views, location: () => window.location.href },
  });
  const app = (
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />
  );
  return { app, daemons, answered, transport };
}

describe('S14 the first run is Onboarding’s daemon-less screen', () => {
  test('S14 no daemon sends home to /onboarding and Onboarding draws the first-run page', async () => {
    go('/app/');
    const { app } = boot({ paired: false });
    const view = await mount(app);
    await until(() => view.container.querySelector('[data-onboarding="setup"]') !== null);
    expect(window.location.pathname).toBe('/onboarding');
    expect(view.container.querySelector('[data-onboarding="setup"]')).not.toBeNull();
    await view.unmount();
  });

  test('S14 a paired device is not sent to /onboarding', async () => {
    go('/app/');
    const { app } = boot({ paired: true });
    const view = await mount(app);
    await until(() => view.container.textContent?.includes('laptop') === true);
    expect(window.location.pathname).toBe('/app/');
    expect(view.container.querySelector('[data-onboarding="setup"]')).toBeNull();
    await view.unmount();
  });

  test('S14 the pairing step opens Access’s own page and learns of a pairing; no code passes through it', async () => {
    go('/onboarding#fy-setup=f1;route=add-client;step=scan');
    const { app, daemons } = boot({ paired: false });
    const view = await mount(app);
    await until(() => view.container.querySelector('[data-onboarding-open-pair]') !== null);
    const open = view.container.querySelector<HTMLElement>('[data-onboarding-open-pair]');
    expect(open).not.toBeNull();
    await interact(() => {
      open?.click();
    });
    expect(window.location.pathname).toBe('/pair');
    await view.unmount();
    // The step never held a pairing code, and the address it rode to Access carries none.
    expect(window.location.href).not.toContain('code');
    expect(daemons.snapshot().daemons).toHaveLength(0);
  });

  test('S14 a pairing seen while the pairing step is on the glass finishes the journey', async () => {
    go('/onboarding#fy-setup=f1;route=add-client;step=scan');
    const { app, daemons } = boot({ paired: false });
    const view = await mount(app);
    await until(() => view.container.querySelector('[data-onboarding-open-pair]') !== null);
    const before = view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen');
    await interact(() => {
      daemons.add({ daemon: 'd9', machine: 'desk', deviceId: 'dev', address: 'http://127.0.0.1:40249' });
    });
    await until(
      () =>
        view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen') !== before,
    );
    expect(view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen')).toBe(
      'done',
    );
    await view.unmount();
  });
});

describe('S14 the steps come from the plugins', () => {
  test('S14 a step panel reaches Onboarding’s page through the generated registry', async () => {
    go('/d/d1/onboarding/steps');
    const { app } = boot({ paired: true });
    const view = await mount(app);
    await until(() => view.container.querySelectorAll('[data-step]').length >= declaredSteps.length);
    // Every declared step has its box, and each box mounts the slot once.
    const boxes = [...view.container.querySelectorAll('[data-step]')].map(node => node.getAttribute('data-step'));
    expect(boxes.toSorted()).toEqual(declaredSteps.map(step => `${step.plugin}.${step.id}`).toSorted());
    expect(declaredSteps.map(step => step.plugin).toSorted()).toEqual(
      ['claude-code', 'codex', 'logins', 'runtimes', 'shells'].toSorted(),
    );
    await view.unmount();
  });

  test('S14 M2 a machine with steps still pending reaches its steps page from its Settings › Setup tab', async () => {
    go('/d/d1/settings/onboarding');
    const { app } = boot({ paired: true });
    const view = await mount(app);
    await until(() => view.container.querySelector('[data-onboarding-open-steps]') !== null);
    expect(view.container.querySelector('[data-onboarding-setup-tab]')?.getAttribute('data-onboarding-setup-tab')).toBe(
      String(declaredSteps.length),
    );
    const open = view.container.querySelector<HTMLElement>('[data-onboarding-open-steps]');
    expect(open?.getAttribute('href')).toBe('/d/d1/onboarding/steps');
    await interact(() => {
      open?.click();
    });
    await until(() => view.container.querySelector('[data-onboarding-steps]') !== null);
    expect(window.location.pathname).toBe('/d/d1/onboarding/steps');
    await view.unmount();
  });

  test('S14 a step with no panel from its plugin still has its box and its answers', async () => {
    go('/d/d1/onboarding/steps');
    const { app, answered } = boot({
      paired: true,
      steps: [{ plugin: 'nobody', id: 'nothing', title: 'No panel', order: 1, state: 'pending' }],
    });
    const view = await mount(app);
    await until(() => view.container.querySelector('[data-step-done]') !== null);
    await interact(() => {
      view.container.querySelector<HTMLElement>('[data-step-done]')?.click();
    });
    await until(() => answered.length > 0);
    expect(answered).toEqual(['POST /v1/onboarding/steps/nobody/nothing {"state":"done"}']);
    await view.unmount();
  });

  test('S14 a machine with nothing to set up says so and still opens the machine', async () => {
    go('/d/d1/onboarding/steps');
    const { app } = boot({ paired: true, steps: [] });
    const view = await mount(app);
    await until(() => view.container.querySelector('[data-onboarding-no-steps]') !== null);
    expect(view.container.querySelector('[data-onboarding-open-machine]')?.getAttribute('href')).toBe('/d/d1');
    await view.unmount();
  });
});
