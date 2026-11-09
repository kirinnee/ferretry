/**
 * S14 — Onboarding's own views, driven in isolation: the share sheet port, the steps screen outside a shell (which has
 * no machine to draw), a read that fails, and the first-run page's pairing hand-off with a fake paired list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DaemonlessPorts } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  browserSetupShare,
  createOnboardingRoute,
  createSetupTab,
  createStepsScreen,
  PAIR_AND_RETURN,
  PAIR_PATH,
} from '../../../app/views/onboarding-views.tsx';
import { RouterProvider } from '@ferretry/app/testing/router';
import { DEVICE_SENTENCES } from '../../../app/device-kind.ts';
import { detectDeviceKind } from '../../../app/device-kind.ts';
import { LINK_COSTS } from '../../../app/link-costs.ts';
import { startOnboardingPairing } from '../../../app/onboarding-progress.ts';
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

  it('n3 says a failed read failed, offers a retry, and draws the steps when the retry works', async () => {
    let offline = true;
    const flaky = clientOf(() => {
      if (offline) throw new Error('offline');
      return VIEW;
    });
    noteClientDaemon(flaky.client, 'd1');
    const Flaky = createStepsScreen(flaky.client);
    const broken = await mount(<Flaky params={{}} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(broken.container.textContent).not.toContain('Loading the setup steps');
    expect(broken.container.querySelector('[data-onboarding-read-failed]')?.textContent).toContain(
      'Could not read the setup steps',
    );
    offline = false;
    await interact(() => {
      broken.container.querySelector<HTMLElement>('[data-onboarding-retry]')?.click();
    });
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(broken.container.querySelector('[data-onboarding-read-failed]')).toBeNull();
    expect(broken.container.querySelector('[data-step="logins.login"]')).not.toBeNull();
    await broken.unmount();
  });

  it('draws the steps once a machine is noted for the client, with the machine link on the router', async () => {
    const working = clientOf(() => VIEW);
    noteClientDaemon(working.client, 'd1');
    const Working = createStepsScreen(working.client);
    const drawn = await mount(
      <RouterProvider>
        <Working params={{}} />
      </RouterProvider>,
    );
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(drawn.container.querySelector('[data-step="logins.login"]')).not.toBeNull();
    const link = drawn.container.querySelector<HTMLAnchorElement>('[data-onboarding-open-machine]');
    expect(link?.getAttribute('href')).toBe('/d/d1');
    // n2: a plain click moves with the router (the browser's own navigation is held back), no page load.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await interact(() => {
      link?.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe('/d/d1');
    // A modified click is the browser's (a new tab), not the router's.
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    await interact(() => {
      link?.dispatchEvent(modified);
    });
    expect(modified.defaultPrevented).toBe(false);
    window.history.replaceState(null, '', '/');
    await drawn.unmount();
  });

  it('says so when a machine has nothing to set up, and still links to the machine', async () => {
    const { client } = clientOf(() => ({ steps: [], complete: true }));
    noteClientDaemon(client, 'd1');
    const Steps = createStepsScreen(client);
    const view = await mount(<Steps params={{}} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(view.container.querySelector('[data-onboarding-no-steps]')).not.toBeNull();
    expect(view.container.querySelector('[data-onboarding-open-machine]')?.getAttribute('href')).toBe('/d/d1');
    await view.unmount();
  });

  it('M3 n1 says what linking the terminal’s sign-in costs under a found step the check marked linked, and nowhere else', async () => {
    const steps = [
      // Installed, not a sign-in: no mark, no sentence.
      { plugin: 'claude-code', id: 'harness', title: 'Claude Code', order: 20, state: 'found' as const },
      { plugin: 'codex', id: 'harness', title: 'Codex', order: 21, state: 'pending' as const },
      // The terminal's own sign-in, linked: the sentence, whatever plugin owns the step (no plugin id is named here).
      { plugin: 'logins', id: 'login', title: 'Sign in', order: 30, state: 'found' as const, linked: true as const },
      {
        plugin: 'elsewhere',
        id: 'sign-in',
        title: 'Elsewhere',
        order: 31,
        state: 'found' as const,
        linked: true as const,
      },
      { plugin: 'shells', id: 'nix', title: 'Shells', order: 80, state: 'found' as const },
      { plugin: 'runtimes', id: 'runtimes', title: 'Name your runtimes', order: 40, state: 'done' as const },
    ];
    const { client } = clientOf(() => ({ steps, complete: false }));
    noteClientDaemon(client, 'd1');
    const Steps = createStepsScreen(client);
    const view = await mount(<Steps params={{}} />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    const costs = (subject: string): string | null =>
      view.container.querySelector(`[data-step="${subject}"] [data-link-costs]`)?.textContent ?? null;
    expect(costs('claude-code.harness')).toBeNull();
    expect(costs('logins.login')).toBe(LINK_COSTS);
    expect(costs('elsewhere.sign-in')).toBe(LINK_COSTS);
    expect(costs('codex.harness')).toBeNull();
    expect(costs('shells.nix')).toBeNull();
    expect(costs('runtimes.runtimes')).toBeNull();
    expect(view.container.querySelectorAll('[data-link-costs]')).toHaveLength(2);
    await view.unmount();
  });

  it('M2 the Setup tab is the way back to the steps page: it counts what is pending and links there', async () => {
    const pending = { steps: [VIEW.steps[0], { ...VIEW.steps[0], id: 'b' }], complete: false };
    const { client } = clientOf(() => pending);
    noteClientDaemon(client, 'd1');
    const Tab = createSetupTab(client);
    const view = await mount(<Tab />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    const tab = view.container.querySelector('[data-onboarding-setup-tab]');
    expect(tab?.getAttribute('data-onboarding-setup-tab')).toBe('2');
    expect(tab?.textContent).toContain('2 setup steps on this machine have not been looked at yet.');
    expect(view.container.querySelector('[data-onboarding-open-steps]')?.getAttribute('href')).toBe(
      '/d/d1/onboarding/steps',
    );
    await view.unmount();

    for (const [steps, sentence] of [
      [[VIEW.steps[0]], '1 setup step on this machine has not been looked at yet.'],
      [[{ ...VIEW.steps[0], state: 'done' as const }], 'Every setup step on this machine has an answer.'],
    ] as const) {
      const one = clientOf(() => ({ steps, complete: false }));
      noteClientDaemon(one.client, 'd1');
      const OneTab = createSetupTab(one.client);
      const drawn = await mount(<OneTab />);
      await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
      expect(drawn.container.textContent).toContain(sentence);
      await drawn.unmount();
    }
  });

  it('the Setup tab draws nothing outside a machine, says it is looking, and says a failed read failed', async () => {
    const outside = clientOf(() => VIEW);
    const Outside = createSetupTab(outside.client);
    const none = await mount(<Outside />);
    expect(none.container.textContent).toBe('');
    await none.unmount();

    const waiting = clientOf(() => new Promise(() => undefined));
    noteClientDaemon(waiting.client, 'd1');
    const Waiting = createSetupTab(waiting.client);
    const looking = await mount(<Waiting />);
    expect(looking.container.textContent).toContain('Looking at the setup steps');
    await looking.unmount();

    let offline = true;
    const flaky = clientOf(() => {
      if (offline) throw new Error('offline');
      return VIEW;
    });
    noteClientDaemon(flaky.client, 'd1');
    const Flaky = createSetupTab(flaky.client);
    const view = await mount(<Flaky />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(view.container.querySelector('[data-onboarding-read-failed]')?.textContent).toContain(
      'Could not read the setup steps',
    );
    offline = false;
    await interact(() => {
      view.container.querySelector<HTMLElement>('[data-onboarding-retry]')?.click();
    });
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(view.container.querySelector('[data-onboarding-open-steps]')).not.toBeNull();
    await view.unmount();
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
    // n3: the failed answer says so and can be tried again; a good one clears the sentence.
    expect(view.container.querySelector('[data-onboarding-unsaved]')?.textContent).toContain('not saved');
    fail = false;
    await press('[data-onboarding-retry-answer]');
    expect(sent).toHaveLength(4);
    expect(view.container.querySelector('[data-onboarding-unsaved]')).toBeNull();
    await view.unmount();
  });
});

describe('S14 the first-run route’s pairing hand-off', () => {
  const Route = (ports: DaemonlessPorts) => createOnboardingRoute(ports);
  // The place is stored in the browser; every case starts from an empty one.
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

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
    expect(moves).toEqual([PAIR_AND_RETURN]);
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

  /** The return Access navigates to: the bare first-run address, with no fragment. */
  const BARE = 'https://f.invalid/onboarding';
  const HANDOFF = 'https://f.invalid/onboarding#fy-setup=f1;route=add-client;step=scan';
  const screenOf = (view: { container: HTMLElement }) =>
    view.container.querySelector('[data-onboarding="setup"]')?.getAttribute('data-onboarding-screen');

  it('M2 coming back from the pairing page with a new machine finishes the step and shows the next stage', async () => {
    // A walk this browser already stored (Pair again, or an earlier visit) is on the pairing step.
    startOnboardingPairing(detectDeviceKind(navigator));
    let here = BARE;
    const moves: string[] = [];
    const paired = pairedList({ daemons: [], selected: null });
    const OnboardingRoute = Route(paired.ports);
    const draw = () => (
      <OnboardingRoute
        params={{}}
        navigate={to => moves.push(to)}
        location={() => here}
        chooseDaemon={async () => undefined}
      />
    );
    const first = await mount(draw());
    await interact(() => {
      first.container.querySelector<HTMLElement>('[data-onboarding-open-pair]')?.click();
    });
    // The first run left for Access's page and asked to be sent back here.
    expect(moves).toEqual([PAIR_AND_RETURN]);
    expect(PAIR_AND_RETURN.startsWith(`${PAIR_PATH}?return=`)).toBe(true);
    expect(decodeURIComponent(PAIR_AND_RETURN)).toBe('/pair?return=/onboarding');
    await first.unmount();
    // Access paired a machine and navigated back to the BARE address: the pairing step is not asked again.
    paired.set({ daemons: [{ daemon: 'd1' }], selected: 'd1' });
    here = BARE;
    const back = await mount(draw());
    expect(screenOf(back)).toBe('done');
    expect(back.container.querySelector('[data-onboarding-open-pair]')).toBeNull();
    await back.unmount();
  });

  it('M2 a hand-off arrival that went to the pairing page lands on the "it worked" stage when it comes back', async () => {
    let here = HANDOFF;
    const paired = pairedList({ daemons: [], selected: null });
    const OnboardingRoute = Route(paired.ports);
    const draw = () => (
      <OnboardingRoute
        params={{}}
        navigate={() => undefined}
        location={() => here}
        chooseDaemon={async () => undefined}
      />
    );
    const first = await mount(draw());
    expect(screenOf(first)).not.toBe('done');
    await interact(() => {
      first.container.querySelector<HTMLElement>('[data-onboarding-open-pair]')?.click();
    });
    await first.unmount();
    // Access paired a machine and navigated to the bare address: the fragment is gone, the place was kept.
    paired.set({ daemons: [{ daemon: 'd1' }], selected: 'd1' });
    here = BARE;
    const back = await mount(draw());
    expect(screenOf(back)).toBe('done');
    await back.unmount();
  });

  it('M2 coming back with no new machine stays on the pairing step, and a later visit starts from the list as it is', async () => {
    startOnboardingPairing(detectDeviceKind(navigator));
    const paired = pairedList({ daemons: [{ daemon: 'd1' }], selected: 'd1' });
    const OnboardingRoute = Route(paired.ports);
    const draw = () => (
      <OnboardingRoute
        params={{}}
        navigate={() => undefined}
        location={() => BARE}
        chooseDaemon={async () => undefined}
      />
    );
    const first = await mount(draw());
    await interact(() => {
      first.container.querySelector<HTMLElement>('[data-onboarding-open-pair]')?.click();
    });
    await first.unmount();
    // Back with the same single machine (the person backed out): nothing was paired, the step stays.
    const again = await mount(draw());
    expect(again.container.querySelector('[data-onboarding-open-pair]')).not.toBeNull();
    // The trip is over: a machine appearing now is a pairing seen while the step is open, not a stale trip.
    await again.unmount();
    paired.set({ daemons: [{ daemon: 'd1' }, { daemon: 'd2' }], selected: 'd1' });
    const later = await mount(draw());
    expect(later.container.querySelector('[data-onboarding-open-pair]')).not.toBeNull();
    await later.unmount();
  });

  it('m1 says what kind of device this is on the first run, once', async () => {
    const paired = pairedList({ daemons: [], selected: null });
    const OnboardingRoute = Route(paired.ports);
    const view = await mount(
      <OnboardingRoute
        params={{}}
        navigate={() => undefined}
        location={() => 'https://f.invalid/onboarding'}
        chooseDaemon={async () => undefined}
      />,
    );
    const sentences = view.container.querySelectorAll('[data-device-sentence]');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.textContent).toBe(DEVICE_SENTENCES.desktop);
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
