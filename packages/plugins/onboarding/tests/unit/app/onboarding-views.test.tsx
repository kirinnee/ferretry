/**
 * S14 — Onboarding's own views, driven in isolation: the share sheet port, the steps screen outside a shell (which has
 * no machine to draw), a read that fails, and the first-run page's pairing hand-off with a fake paired list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DaemonlessPorts, HostedRelayState } from '@ferretry/app';
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
import { ONBOARDING_PROGRESS_KEY, startOnboardingPairing } from '../../../app/onboarding-progress.ts';
import { ONBOARDING_PAIR_TRIP_KEY } from '../../../app/pair-trip.ts';
import { interact, mount } from '../support/dom.ts';

interface Listing {
  readonly daemons: readonly { readonly daemon: string }[];
  readonly selected: string | null;
}

/** A paired list with the three members a daemon-less screen uses; the pairing code is never in it. */
function pairedList(start: Listing, hostedRelay?: () => Promise<HostedRelayState>) {
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
    ports: { daemons: list, ...(hostedRelay === undefined ? {} : { hostedRelay }) } as unknown as DaemonlessPorts,
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
  setUp: false,
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

describe('S14 the steps screen is now a way into the setup flow', () => {
  it('opens the flow on the machine, replacing its own entry, once', async () => {
    const { client } = clientOf(() => VIEW);
    noteClientDaemon(client, 'd1');
    const Steps = createStepsScreen(client);
    window.history.replaceState(null, '', '/d/d1/onboarding/steps');
    const view = await mount(
      <RouterProvider>
        <Steps params={{}} />
      </RouterProvider>,
    );
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    expect(window.location.pathname).toBe('/d/d1/onboarding/setup');
    expect(view.container.textContent).toContain('Opening the setup');
    window.history.replaceState(null, '', '/');
    await view.unmount();
  });

  it('says it is opening outside a shell (no machine, no router) and navigates nowhere', async () => {
    const { client } = clientOf(() => VIEW);
    const Steps = createStepsScreen(client);
    const view = await mount(<Steps params={{}} />);
    expect(view.container.textContent).toContain('Opening the setup');
    await view.unmount();
  });

  it('M2 the Setup tab is the way back to the steps page: it counts what is pending and links there', async () => {
    const pending = { steps: [VIEW.steps[0], { ...VIEW.steps[0], id: 'b' }], complete: false, setUp: false };
    const { client } = clientOf(() => pending);
    noteClientDaemon(client, 'd1');
    const Tab = createSetupTab(client);
    const view = await mount(<Tab />);
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
    const tab = view.container.querySelector('[data-onboarding-setup-tab]');
    expect(tab?.getAttribute('data-onboarding-setup-tab')).toBe('2');
    expect(tab?.textContent).toContain('2 setup steps on this machine have not been looked at yet.');
    expect(view.container.querySelector('[data-onboarding-open-steps]')?.getAttribute('href')).toBe(
      '/d/d1/onboarding/setup',
    );
    await view.unmount();

    for (const [steps, sentence] of [
      [[VIEW.steps[0]], '1 setup step on this machine has not been looked at yet.'],
      [[{ ...VIEW.steps[0], state: 'done' as const }], 'Every setup step on this machine has an answer.'],
    ] as const) {
      const one = clientOf(() => ({ steps, complete: false, setUp: false }));
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

  it('c58-07 a reload on the pairing page forgets nothing: the count kept in storage tells a new machine from an old one', async () => {
    startOnboardingPairing(detectDeviceKind(navigator));
    const paired = pairedList({ daemons: [], selected: null });
    const props = {
      params: {},
      navigate: () => undefined,
      location: () => BARE,
      chooseDaemon: async () => undefined,
    };
    const Before = Route(paired.ports);
    const first = await mount(<Before {...props} />);
    await interact(() => {
      first.container.querySelector<HTMLElement>('[data-onboarding-open-pair]')?.click();
    });
    await first.unmount();
    // Only a number is kept, beside the place the journey keeps; never a code, an address or an id.
    expect(localStorage.getItem(ONBOARDING_PAIR_TRIP_KEY)).toBe('0');
    expect(Object.keys(localStorage).sort()).toEqual([ONBOARDING_PROGRESS_KEY, ONBOARDING_PAIR_TRIP_KEY].sort());
    // Access paired a machine, and the document was reloaded in between: a NEW route holds nothing in memory.
    paired.set({ daemons: [{ daemon: 'd1' }], selected: 'd1' });
    const AfterReload = Route(paired.ports);
    const back = await mount(<AfterReload {...props} />);
    expect(screenOf(back)).toBe('done');
    // The trip is over once the step has been on the glass: nothing stays behind in storage.
    expect(localStorage.getItem(ONBOARDING_PAIR_TRIP_KEY)).toBeNull();
    await back.unmount();
  });

  it('c58-07 a kept count that is not a plain number is ignored: the step counts from the list as it is', async () => {
    startOnboardingPairing(detectDeviceKind(navigator));
    localStorage.setItem(ONBOARDING_PAIR_TRIP_KEY, 'd1;code=123456');
    const paired = pairedList({ daemons: [{ daemon: 'd1' }], selected: 'd1' });
    const AfterReload = Route(paired.ports);
    const view = await mount(
      <AfterReload params={{}} navigate={() => undefined} location={() => BARE} chooseDaemon={async () => undefined} />,
    );
    expect(view.container.querySelector('[data-onboarding-open-pair]')).not.toBeNull();
    expect(screenOf(view)).not.toBe('done');
    expect(localStorage.getItem(ONBOARDING_PAIR_TRIP_KEY)).toBeNull();
    await view.unmount();
  });

  /** A first-run journey that stands on the daemon step, where the connection note is drawn. */
  const ON_DAEMON_STEP = 'https://f.invalid/onboarding#fy-setup=f1;route=first-time;target=this;doer=self;step=daemon';
  const noteOf = (view: { container: HTMLElement }) =>
    view.container.querySelector('[data-onboarding-fallback]')?.getAttribute('data-onboarding-fallback');
  const settleTurn = async (): Promise<void> => {
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
  };

  it('c58-07 the connection note says checking until the shell’s answer lands, then says what Connections read', async () => {
    const answers: Record<string, HostedRelayState> = {
      available: { kind: 'available', relayUrl: 'https://relay.example.test' },
      disabled: { kind: 'disabled' },
      undetermined: { kind: 'undetermined', reason: 'nothing answered' },
    };
    for (const [kind, answer] of Object.entries(answers)) {
      let release: (state: HostedRelayState) => void = () => undefined;
      const paired = pairedList(
        { daemons: [], selected: null },
        () => new Promise<HostedRelayState>(resolve => (release = resolve)),
      );
      const OnboardingRoute = Route(paired.ports);
      const view = await mount(
        <OnboardingRoute
          params={{}}
          navigate={() => undefined}
          location={() => ON_DAEMON_STEP}
          chooseDaemon={async () => undefined}
        />,
      );
      expect(noteOf(view)).toBe('checking');
      await interact(() => release(answer));
      await settleTurn();
      expect(noteOf(view)).toBe(kind);
      await view.unmount();
    }
  });

  it('c58-07 a read the shell could not make is said as undetermined, never left at checking and never "switched off"', async () => {
    for (const ports of [
      pairedList({ daemons: [], selected: null }).ports,
      pairedList({ daemons: [], selected: null }, async () => Promise.reject(new Error('refused'))).ports,
    ]) {
      const OnboardingRoute = Route(ports);
      const view = await mount(
        <OnboardingRoute
          params={{}}
          navigate={() => undefined}
          location={() => ON_DAEMON_STEP}
          chooseDaemon={async () => undefined}
        />,
      );
      await settleTurn();
      expect(noteOf(view)).toBe('undetermined');
      expect(view.container.textContent).not.toContain('switched off');
      await view.unmount();
    }
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
    expect(moves).toEqual(['/d/d7/onboarding/setup']);
    await view.unmount();
  });
});
