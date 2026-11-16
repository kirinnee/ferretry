/**
 * S-0356 / S-0386 / S-0407 the hand-off link's address answers. Onboarding builds the link it puts in front of the other
 * device as `/setup#fy-setup=…` (v4's `setupPath`), and the hosted Pages serve `/setup` to the app — so a screen must
 * answer it, or the other device lands on "Nothing is here". It is the SAME first-run page as `/onboarding`, with the
 * place the link carries read from the fragment: one page, two addresses, no second implementation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type DaemonlessPorts, routeTable } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing/router';
import { type ReactElement, Suspense } from 'react';
import app from '../../../app/index.ts';
import { setupHandoffUrl, setupPageUrl } from '../../../app/setup-handoff.ts';
import manifest from '../../../manifest.ts';
import { interact, mount } from '../support/dom.ts';

const screens = (manifest.ui?.screens ?? []).map(screen => ({
  plugin: manifest.id,
  id: screen.id,
  path: screen.path,
  label: screen.id,
}));

const NONE = { daemons: [], selected: null };
const idle = {
  snapshot: () => NONE,
  subscribe: () => () => undefined,
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('the address the hand-off link carries', () => {
  it('S-0356 S-0386 S-0407 /setup is a daemon-less screen of Onboarding, and so is the link it builds, fragment and all', () => {
    const table = routeTable(screens);
    const link = new URL(setupHandoffUrl('https://f.invalid/app/x?y=1#z', { route: 'add-client', step: 'scan' }));
    expect(link.hash).toBe('#fy-setup=f1;route=add-client;step=scan');
    for (const pathname of ['/setup', link.pathname, new URL(setupPageUrl('https://f.invalid/app/')).pathname]) {
      const route = table.parse(pathname);
      expect(route).toMatchObject({ kind: 'screen', screen: { plugin: 'onboarding', id: 'handoff' } });
      expect((route as { daemon?: string }).daemon).toBeUndefined();
    }
    // The first run keeps its own address, and /setup takes nothing beneath it.
    expect(table.parse('/onboarding')).toMatchObject({ kind: 'screen', screen: { id: 'onboarding' } });
    expect(table.parse('/setup/extra').kind).toBe('not-found');
  });
});

describe('the screen behind it', () => {
  it('S-0356 S-0386 S-0407 is the first-run page itself (one page, two addresses), reading the place the link carries', async () => {
    const ports = { daemons: idle } as unknown as DaemonlessPorts;
    const views = app.shell?.daemonless?.(ports) ?? {};
    expect(Object.keys(views).sort()).toEqual(['handoff', 'onboarding']);
    expect(views.handoff).toBe(views.onboarding);

    const Handoff = views.handoff as never as (props: {
      params: Record<string, never>;
      navigate: () => void;
      location: () => string;
      chooseDaemon: () => Promise<undefined>;
    }) => ReactElement;
    const view = await mount(
      <RouterProvider screens={screens}>
        <Suspense fallback={null}>
          <Handoff
            chooseDaemon={async () => undefined}
            location={() => 'https://f.invalid/setup#fy-setup=f1;route=add-client;step=scan'}
            navigate={() => undefined}
            params={{}}
          />
        </Suspense>
      </RouterProvider>,
    );
    await interact(async () => {
      for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    });
    // The link said "add a device, at the pairing step": the page is on that step, not at the beginning.
    expect(view.container.querySelector('[data-onboarding-open-pair]')).not.toBeNull();
    await view.unmount();
  });
});
