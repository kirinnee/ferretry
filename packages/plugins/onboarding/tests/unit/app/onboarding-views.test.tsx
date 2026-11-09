/**
 * S14 — Onboarding's own views, driven in isolation: the share sheet port, the steps screen outside a shell (which has
 * no machine to draw), a read that fails, and the first-run page's pairing hand-off with a fake paired list.
 */
import { describe, expect, it } from 'bun:test';
import type { DaemonlessPorts } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  browserSetupShare,
  createOnboardingRoute,
  createStepsScreen,
  PAIR_PATH,
} from '../../../app/views/onboarding-views.tsx';
import { interact, mount } from '../support/dom.ts';

interface Listing {
  readonly daemons: readonly { readonly daemon: string }[];
  readonly selected: string | null;
}

/** A paired list with the three members a daemon-less screen uses; the pairing code is never in it. */
function pairedList(start: Listing) {
  let current = start;
  const listeners = new Set<() => void>();
  const list = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ports: { daemons: list } as unknown as DaemonlessPorts,
    set: (next: Listing) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
}

const VIEW = {
  steps: [{ plugin: 'logins', id: 'login', title: 'Sign in', order: 30, state: 'pending' as const }],
  complete: false,
};

function clientOf(call: (route: string) => unknown): { client: PluginClient; stopped: () => number } {
  let stopped = 0;
  const client = {
    async call(route: string) {
      return call(route);
    },
    subscribe<Name extends string, Payload>(_event: EventDef<Name, Payload>) {
      return () => {
        stopped += 1;
      };
    },
  } as unknown as PluginClient;
  return { client, stopped: () => stopped };
}

describe('S14 browserSetupShare', () => {
  it('is absent where the browser has no share sheet, and a function that hands the payload over where it has', async () => {
    expect(browserSetupShare({})).toBeUndefined();
    const sent: unknown[] = [];
    const share = browserSetupShare({
      share: async data => {
        sent.push(data);
      },
    });
    await share?.({ title: 'Ferretry', url: 'https://f.invalid/setup' });
    expect(sent).toEqual([{ title: 'Ferretry', url: 'https://f.invalid/setup' }]);
  });
});

describe('S14 the steps screen', () => {
  it('says it is loading outside a shell (a client no machine was noted for) and stops listening when it goes', async () => {
    const { client, stopped } = clientOf(() => VIEW);
    const Steps = createStepsScreen(client);
    const view = await mount(<Steps params={{}} />);
    expect(view.container.textContent).toContain('Loading the setup steps');
    await view.unmount();
    expect(stopped()).toBe(1);
  });

  it('keeps saying so when the read fails, and draws the steps once a machine is noted for the client', async () => {
    const failing = clientOf(() => {
      throw new Error('offline');
    });
    noteClientDaemon(failing.client, 'd1');
    const Failing = createStepsScreen(failing.client);
    const broken = await mount(<Failing params={{}} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(broken.container.textContent).toContain('Loading the setup steps');
    await broken.unmount();

    const working = clientOf(() => VIEW);
    noteClientDaemon(working.client, 'd1');
    const Working = createStepsScreen(working.client);
    const drawn = await mount(<Working params={{}} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(drawn.container.querySelector('[data-step="logins.login"]')).not.toBeNull();
    expect(drawn.container.querySelector('[data-onboarding-open-machine]')?.getAttribute('href')).toBe('/d/d1');
    await drawn.unmount();
  });
});

describe('S14 answering a step', () => {
  it('records the answer through Onboarding’s own route, and a failed answer leaves the screen as it was', async () => {
    const sent: string[] = [];
    let fail = false;
    const { client } = clientOf(route => {
      if (route === 'GET /v1/onboarding') return VIEW;
      sent.push(route);
      if (fail) throw new Error('refused');
      return { ...VIEW.steps[0], state: 'done' };
    });
    noteClientDaemon(client, 'd1');
    const Steps = createStepsScreen(client);
    const view = await mount(<Steps params={{}} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    const press = async (selector: string): Promise<void> => {
      await interact(() => {
        view.container.querySelector<HTMLElement>(selector)?.click();
      });
      await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    };
    await press('[data-step-done]');
    await press('[data-step-later]');
    fail = true;
    await press('[data-step-skip]');
    expect(sent).toEqual([
      'POST /v1/onboarding/steps/:plugin/:stepId',
      'POST /v1/onboarding/steps/:plugin/:stepId',
      'POST /v1/onboarding/steps/:plugin/:stepId',
    ]);
    expect(view.container.querySelector('[data-step="logins.login"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('S14 the first-run route’s pairing hand-off', () => {
  const Route = (ports: DaemonlessPorts) => createOnboardingRoute(ports);

  it('opens Access’s pairing page, and holds no subscription once it is gone', async () => {
    const moves: string[] = [];
    const paired = pairedList({ daemons: [], selected: null });
    const OnboardingRoute = Route(paired.ports);
    const view = await mount(
      <OnboardingRoute
        params={{}}
        navigate={to => moves.push(to)}
        location={() => 'https://f.invalid/onboarding#fy-setup=f1;route=add-client;step=scan'}
        chooseDaemon={async () => undefined}
      />,
    );
    const open = view.container.querySelector<HTMLElement>('[data-onboarding-open-pair]');
    expect(open).not.toBeNull();
    await interact(() => {
      open?.click();
    });
    expect(moves).toEqual([PAIR_PATH]);
    expect(paired.listening()).toBeGreaterThan(0);
    await view.unmount();
    expect(paired.listening()).toBe(0);
  });

  it('a pairing seen while the pairing step is open finishes the journey', async () => {
    const paired = pairedList({ daemons: [], selected: null });
    const OnboardingRoute = Route(paired.ports);
    const view = await mount(
      <OnboardingRoute
        params={{}}
        navigate={() => undefined}
        location={() => 'https://f.invalid/onboarding#fy-setup=f1;route=add-client;step=scan'}
        chooseDaemon={async () => undefined}
      />,
    );
    const screen = () =>
      view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen');
    expect(screen()).not.toBe('done');
    await interact(() => paired.set({ daemons: [{ daemon: 'd1' }], selected: 'd1' }));
    expect(screen()).toBe('done');
    await view.unmount();
  });

  it('opens the machine’s steps page, not its sessions, once a daemon is paired and selected', async () => {
    const moves: string[] = [];
    const paired = pairedList({ daemons: [{ daemon: 'd7' }], selected: 'd7' });
    const OnboardingRoute = Route(paired.ports);
    const view = await mount(
      <OnboardingRoute
        params={{}}
        navigate={to => moves.push(to)}
        location={() => 'https://f.invalid/onboarding#fy-setup=f1;route=add-client;step=done'}
        chooseDaemon={async () => undefined}
      />,
    );
    const open = [...view.container.querySelectorAll<HTMLElement>('button')].find(button =>
      /open/i.test(button.textContent ?? ''),
    );
    expect(open).toBeDefined();
    await interact(() => {
      open?.click();
    });
    expect(moves).toEqual(['/d/d7/onboarding/steps']);
    await view.unmount();
  });
});
