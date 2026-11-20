/**
 * Onboarding's app half, parity with today's first-run surfaces (docs/design/rebuild-parity.tsv, owner `onboarding`,
 * kind S). One test per row group, its title naming every row it proves. Each surface is proved by drawing it over a
 * fake client or fake progress store: no daemon, no network, a `.invalid` origin for every link.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { routeTable } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import app from '../../../app/index.ts';
import { CHECKING_HOSTED_RELAY } from '../../../app/hosted-relay-state.ts';
import { OnboardingPage } from '../../../app/onboarding-page.tsx';
import { type OnboardingProgressStorage, OnboardingProgressStore } from '../../../app/onboarding-progress.ts';
import { SetupHandoffPanel } from '../../../app/setup-handoff-panel.tsx';
import { createSetupTab } from '../../../app/views/onboarding-views.tsx';
import manifest from '../../../manifest.ts';
import { interact, mount, must } from '../support/dom.ts';

class MemoryStorage implements OnboardingProgressStorage {
  #value: string | null = null;
  getItem(): string | null {
    return this.#value;
  }
  setItem(_key: string, next: string): void {
    this.#value = next;
  }
}

const HREF = 'https://ferretry.example.invalid/setup';
const screens = (manifest.ui?.screens ?? []).map(screen => ({
  plugin: manifest.id,
  id: screen.id,
  path: screen.path,
  label: screen.id,
}));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('the first-run page and its hand-off panel', () => {
  it('S-0166 OnboardingPage opens on the entry question: three ways in, each a button, and nothing else asked yet', async () => {
    const view = await mount(
      <OnboardingPage
        progress={new OnboardingProgressStore({ storage: new MemoryStorage(), device: 'desktop' })}
        write={async () => {}}
        channel="apt"
        href={HREF}
        share={undefined}
        fleetReady={false}
        connectionStatus={null}
        fallback={CHECKING_HOSTED_RELAY}
        onOpenFleet={() => undefined}
        renderPairing={() => null}
      />,
    );
    const root = must(view.container.querySelector<HTMLElement>('[data-onboarding="setup"]'), 'the setup screen');
    expect(root.getAttribute('data-onboarding-screen')).toBe('entry');
    const routes = [...view.container.querySelectorAll<HTMLButtonElement>('button[data-onboarding-route]')].map(
      button => button.getAttribute('data-onboarding-route'),
    );
    expect(routes.toSorted()).toEqual(['add-client', 'add-daemon', 'first-time']);
    await interact(() => {
      must(
        view.container.querySelector<HTMLElement>('button[data-onboarding-route="add-client"]'),
        'the add-a-client answer',
      ).click();
    });
    expect(root.getAttribute('data-onboarding-route')).toBe('add-client');
    await view.unmount();
  });

  it('S-0237 SetupHandoffPanel draws the link as a QR for a phone, and as a link to copy for a computer', async () => {
    const link = 'https://f.invalid/setup#fy-setup=f1;route=add-client;step=scan';
    const phone = await mount(
      <SetupHandoffPanel
        url={link}
        plainUrl={HREF}
        receiver="phone"
        write={async () => undefined}
        share={undefined}
        label="Link carrying this setup"
      />,
    );
    expect(phone.container.querySelector('[data-onboarding-qr]')).not.toBeNull();
    expect(phone.container.querySelector('[data-onboarding-handoff-url]')?.textContent).toBe(link);
    expect(phone.container.querySelector('button[aria-label="Copy setup link"]')).not.toBeNull();
    await phone.unmount();

    const computer = await mount(
      <SetupHandoffPanel
        url={link}
        plainUrl={HREF}
        receiver="computer"
        write={async () => undefined}
        share={undefined}
        label="Link carrying this setup"
      />,
    );
    expect(computer.container.querySelector('[data-onboarding-qr]')).toBeNull();
    expect(computer.container.querySelector('[data-onboarding-handoff-url]')?.textContent).toBe(link);
    await computer.unmount();
  });
});

describe('the feature, its routes and its settings entry', () => {
  it('S-0314 the feature is Onboarding’s own: its screens, settings tab and shell views are declared and built, the Home stepper and the two pages Onboarding draws in its own flow', () => {
    expect(manifest.kinds).toContain('view');
    expect((manifest.ui?.screens ?? []).map(screen => screen.id).toSorted()).toEqual([
      'flow',
      'handoff',
      'onboarding',
      'setup',
      'steps',
    ]);
    const half = app.build?.({ manifest: app.manifest, client: {} as PluginClient });
    expect(Object.keys(half?.screens ?? {}).toSorted()).toEqual(['flow', 'handoff', 'onboarding', 'setup', 'steps']);
    expect(Object.keys(half?.settings ?? {})).toEqual(['setup']);
    expect(Object.keys(half?.panels ?? {})).toEqual(['first-run-stepper', 'name-step', 'appearance-step']);
    expect((manifest.ui?.panels ?? []).map(panel => `${panel.slot}.${panel.id}`)).toEqual([
      'daemon.status.first-run-stepper',
      'onboarding.step.name-step',
      'onboarding.step.appearance-step',
    ]);
    // The flow is drawn alone: no drawer, bars or side column.
    expect(manifest.ui?.screens?.find(screen => screen.id === 'flow')).toMatchObject({
      path: 'onboarding/setup',
      chrome: 'none',
    });
    // Onboarding’s own two pages: the machine’s name (daemon) and this device’s look (client).
    expect(manifest.onboarding).toEqual([
      expect.objectContaining({ id: 'name' }),
      expect.objectContaining({ id: 'appearance', side: 'client' }),
    ]);
  });

  it('S-0373 S-0398 /d/<machine>/setup opens the machine-setup screen of that machine, the steps screen the first run offers', () => {
    const route = routeTable(screens).parse('/d/m1/setup');
    expect(route).toMatchObject({ kind: 'screen', daemon: 'm1', screen: { plugin: 'onboarding', id: 'setup' } });
    // The v4 screen's address answers too, and the first run itself keeps no machine in its address.
    expect(routeTable(screens).parse('/d/m1/onboarding/steps')).toMatchObject({
      kind: 'screen',
      daemon: 'm1',
      screen: { id: 'steps' },
    });
    expect((routeTable(screens).parse('/onboarding') as { daemon?: string }).daemon).toBeUndefined();
  });

  it('S-0504 the machine’s settings list a Setup entry that says how many steps are unanswered and links to the steps', async () => {
    expect(manifest.ui?.settings?.find(tab => tab.id === 'setup')).toMatchObject({ group: 'agents', label: 'Setup' });
    const client = {
      async call() {
        return {
          steps: [{ plugin: 'shells', id: 'nix', title: 'Shells', order: 80, state: 'pending' }],
          complete: false,
          setUp: false,
        };
      },
      subscribe: () => () => undefined,
    } as unknown as PluginClient;
    noteClientDaemon(client, 'd1');
    const Tab = createSetupTab(client);
    const view = await mount(<Tab />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(view.container.textContent).toContain('1 setup step on this machine has not been looked at yet.');
    expect(view.container.querySelector('[data-onboarding-open-steps]')?.getAttribute('href')).toBe(
      '/d/d1/onboarding/setup',
    );
    await view.unmount();
  });
});
