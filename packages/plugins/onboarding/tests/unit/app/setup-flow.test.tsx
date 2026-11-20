/**
 * The setup flow, drawn as the shell draws it: Onboarding's identity over fake machines, the `onboarding.step` slot
 * filled by the fake plugin's pages (tests/fixtures/fake-steps). What is asserted is what the person sees and what is
 * recorded: one page at a time, the loading cover, Back/Next/Later, a page that skips itself, the client ledger, and
 * that a plugin's segment memory (this run only) never reaches storage.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  must,
  noteClientDaemon,
  type PlacedPanel,
  WithSlotPanels,
} from '@ferretry/app/testing';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { Instant } from '@ferretry/std';
import { useEffect, type ReactNode } from 'react';
import { createSetupFlow } from '../../../app/features/setup-flow/setup-flow.tsx';
import { CLIENT_LATER_KEY } from '../../../app/features/setup-flow/client-later.ts';
import { CLIENT_LEDGER_KEY } from '../../../app/lib/client-ledger.ts';
import { fakeDaemon } from '../../fixtures/fake-steps/index.ts';
import { ChoosePage, FinishPage, LookPage, WelcomePage } from '../../fixtures/fake-steps/pages.tsx';

ensureDom();

const AT = '2026-11-19T09:00:00.000Z' as Instant;
const A = 'fy_daemon_a';
const B = 'fy_daemon_b';

/** A page that shows at once with one button, and one that never answers. */
function ReadyPage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => step.ready(), [step]);
  return <p>ready</p>;
}
function SilentPage(): ReactNode {
  return <p>never ready</p>;
}
function BusyPage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => {
    step.ready();
    step.busy('Installing…');
  }, [step]);
  return <p>working</p>;
}

/** A page whose save is slow: it holds the footer (busy) until the test lets the save finish, then answers and moves on. */
const slow: { finish: () => void } = { finish: () => undefined };
function SlowSavePage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => {
    step.ready();
    step.busy('Saving…');
    slow.finish = () => {
      step.busy(null);
      step.done();
      step.next();
    };
  }, [step]);
  return <p>saving</p>;
}
/** A page that keeps its host and calls it late, after the person has moved on. */
const stale: { host: StepHost | undefined } = { host: undefined };
function StalePage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => {
    step.ready();
    stale.host = step;
  }, [step]);
  return <p>stale</p>;
}

const PAGES: Readonly<Record<string, (step: StepHost) => ReactNode>> = {
  'onboarding.name': step => <ReadyPage step={step} />,
  'onboarding.appearance': step => <ReadyPage step={step} />,
  'fake-pack.welcome': step => <WelcomePage step={step} />,
  'fake-pack.choose': step => <ChoosePage step={step} />,
  'fake-pack.finish': step => <FinishPage step={step} />,
  'fake-pack.look': step => <LookPage step={step} />,
  'fake-pack.silent': () => <SilentPage />,
  'fake-pack.busy': step => <BusyPage step={step} />,
  'fake-pack.slowsave': step => <SlowSavePage step={step} />,
  'fake-pack.stale': step => <StalePage step={step} />,
  'fake-pack.after': step => <ReadyPage step={step} />,
  'fake-pack.legacy': () => <p>an old page that never calls ready</p>,
  'fake-pack.forgot': step => <ReadyPage step={step} />,
};

const stepPanel = (plugin: string, id: string): PlacedPanel => ({
  plugin,
  id,
  view: props => PAGES[String(props.subject)]?.(props.step as StepHost) ?? null,
});

interface Machine {
  readonly id: string;
  readonly name: string;
  readonly steps: ReturnType<typeof fakeDaemon>['steps'];
}

function setup(options: {
  readonly machines?: readonly Machine[];
  readonly search?: string;
  readonly silenceMs?: number;
  readonly storage?: Map<string, string>;
  readonly failAnswers?: boolean;
  /** Step ids whose answer the machine refuses (a test may empty it to let a retry through). */
  readonly failSteps?: Set<string>;
  /** Machines whose steps read never answers (parked behind a passkey unlock). */
  readonly hangReads?: ReadonlySet<string>;
  /** Machines whose steps read is refused until the set is emptied. */
  readonly refuseReads?: Set<string>;
  readonly peerWaitMs?: number;
  readonly report?: (message: string) => void;
  /** Holds a daemon answer until the returned promise settles (the test releases it). */
  readonly gate?: (state: string, step: string) => Promise<void> | undefined;
}) {
  const machines = options.machines ?? [fakeDaemon(A, 'Studio')];
  const answers: { daemon: string; plugin: string; step: string; state: string }[] = [];
  const reads: { daemon: string; init: unknown }[] = [];
  const arrived: { step: string; state: string }[] = [];
  const clients = new Map<string, PluginClient>();
  for (const machine of machines) {
    const client = {
      async call(route: string, request?: { params?: { plugin: string; stepId: string }; body?: { state: string } }) {
        if (route === 'GET /v1/onboarding') {
          reads.push({ daemon: machine.id, init: request });
          if (options.hangReads?.has(machine.id) === true) return new Promise(() => undefined);
          if (options.refuseReads?.has(machine.id) === true) throw new Error('unreachable');
          return { steps: machine.steps, complete: false, setUp: false };
        }
        arrived.push({ step: request?.params?.stepId ?? '', state: request?.body?.state ?? '' });
        await options.gate?.(request?.body?.state ?? '', request?.params?.stepId ?? '');
        if (options.failAnswers === true || options.failSteps?.has(request?.params?.stepId ?? '') === true)
          throw new Error('refused');
        answers.push({
          daemon: machine.id,
          plugin: request?.params?.plugin ?? '',
          step: request?.params?.stepId ?? '',
          state: request?.body?.state ?? '',
        });
        return { ...machine.steps[0], state: request?.body?.state };
      },
      subscribe: () => () => undefined,
    } as unknown as PluginClient;
    noteClientDaemon(client, machine.id);
    clients.set(machine.id, client);
  }
  const writes: string[] = [];
  const store = options.storage ?? new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      store.set(key, value);
    },
  };
  const harness = deviceViewHarness({ plugin: 'onboarding', fragments: [] });
  harness.setRows(
    machines.map(machine =>
      fakeReachRow({ daemon: machine.id, machine: machine.name, client: must(clients.get(machine.id), 'a client') }),
    ),
  );
  const Flow = createSetupFlow(must(clients.get(must(machines[0], 'a machine').id), 'a client'), {
    storage: () => storage,
    now: () => AT,
    search: () => options.search ?? '',
    ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
    ...(options.peerWaitMs === undefined ? {} : { peerWaitMs: options.peerWaitMs }),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  const slots = {
    'onboarding.step': [
      stepPanel('onboarding', 'name-step'),
      stepPanel('onboarding', 'appearance-step'),
      stepPanel('fake-pack', 'step'),
    ],
  };
  const tree = (
    <harness.Harness place="daemon">
      <WithSlotPanels slots={slots}>
        <Flow params={{}} />
      </WithSlotPanels>
    </harness.Harness>
  );
  return { tree, answers, arrived, reads, writes, store };
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const settle = (): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, 20)));
const press = (selector: string) => interact(() => view?.container.querySelector<HTMLElement>(selector)?.click());
const next = () => press('[data-step-next]');
const pageKey = (): string | null | undefined =>
  view?.container.querySelector('[data-flow-page]')?.getAttribute('data-flow-page');
const progressText = (): string | null | undefined =>
  view?.container.querySelector('.fy-sp-progress__text')?.textContent;
const buttonText = (label: string): HTMLElement | undefined =>
  [...(view?.container.querySelectorAll<HTMLElement>('button') ?? [])].find(
    button => button.textContent?.trim() === label,
  );
const click = (label: string) => interact(() => buttonText(label)?.click());

describe('the setup flow', () => {
  it('draws one page at a time, the machine first, and goes on and back', async () => {
    const run = setup({});
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('onboarding.name');
    expect(view.container.querySelectorAll('[data-flow-page]')).toHaveLength(1);
    expect(view.container.querySelector('[data-step-back]')).toBeNull();
    await next();
    expect(pageKey()).toBe('fake-pack.welcome');
    expect(progressText()).toBe('Fake Pack · 1 of 3');
    await next();
    expect(pageKey()).toBe('fake-pack.choose');
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.welcome');
    expect(view.container.querySelector('[data-flow-page]')?.getAttribute('data-direction')).toBe('back');
  });

  it('draws no chrome of its own beyond the frame: no nav, no drawer', async () => {
    view = await mount(setup({}).tree);
    await settle();
    expect(view.container.querySelector('nav')).toBeNull();
    expect(view.container.querySelector('[data-living-background]')).not.toBeNull();
  });

  it('a page that skips itself draws nothing and the progress total shrinks', async () => {
    view = await mount(setup({}).tree);
    await settle();
    await next();
    await click('Everything');
    await next(); // welcome -> choose, which sees mode "everything" and skips
    await settle();
    expect(pageKey()).toBe('fake-pack.finish');
    expect(progressText()).toBe('Fake Pack · 2 of 2');
    // Back never lands on the skipped page.
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.welcome');
  });

  it('keeps the segment memory in memory only: no storage write carries it', async () => {
    const run = setup({});
    view = await mount(run.tree);
    await settle();
    await next();
    await click('Everything');
    await next();
    await settle();
    expect(run.writes.filter(key => key !== CLIENT_LEDGER_KEY && key !== CLIENT_LATER_KEY)).toEqual([]);
    expect([...run.store.values()].join('')).not.toContain('everything');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('records a daemon step on the machine when Next follows its answer, and Later records later', async () => {
    const run = setup({});
    view = await mount(run.tree);
    await settle();
    await next(); // name: Next is "done"
    await settle();
    await next(); // welcome
    await click('Later'); // choose: later
    await settle();
    expect(run.answers).toEqual([
      { daemon: A, plugin: 'onboarding', step: 'name', state: 'done' },
      { daemon: A, plugin: 'fake-pack', step: 'welcome', state: 'done' },
      { daemon: A, plugin: 'fake-pack', step: 'choose', state: 'later' },
    ]);
  });

  it('a client page answered writes the device ledger; one left for later writes the later list', async () => {
    const run = setup({ search: '?phase=client' });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('onboarding.appearance');
    await next();
    await click('Later');
    await settle();
    expect(run.answers).toEqual([]); // client steps are never recorded on the machine
    const ledger = JSON.parse(run.store.get(CLIENT_LEDGER_KEY) ?? '{}') as { steps: Record<string, unknown> };
    expect(Object.keys(ledger.steps)).toEqual(['onboarding.appearance']);
    expect(Object.keys((JSON.parse(run.store.get(CLIENT_LATER_KEY) ?? '{}') as { steps: object }).steps)).toEqual([
      'fake-pack.look',
    ]);
  });

  it('the Pair journey asks only this device; a client page already on the ledger is skipped', async () => {
    const store = new Map<string, string>([
      [CLIENT_LEDGER_KEY, JSON.stringify({ format: 1, steps: { 'onboarding.appearance': { at: AT, daemons: [A] } } })],
    ]);
    view = await mount(setup({ search: '?phase=client', storage: store }).tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.look');
    expect(progressText()).toBe('This device · 1 of 1');
  });

  it('resumes at the first page the machine has no answer for', async () => {
    const machine = fakeDaemon(A, 'Studio');
    const answered = {
      ...machine,
      steps: machine.steps.map(step => (step.id === 'name' ? { ...step, state: 'done' as const } : step)),
    };
    view = await mount(setup({ machines: [answered] }).tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.welcome');
  });

  it('says "Only on <machine>" for a client page only some paired machines carry', async () => {
    const both = fakeDaemon(A, 'Studio');
    const bare = fakeDaemon(B, 'Laptop', { withFake: false });
    view = await mount(setup({ machines: [both, bare], search: '?phase=client' }).tree);
    await settle();
    expect(pageKey()).toBe('onboarding.appearance');
    expect(view.container.querySelector('[data-only-on]')).toBeNull(); // every machine has it
    await next();
    expect(pageKey()).toBe('fake-pack.look');
    expect(view.container.querySelector('[data-only-on]')?.textContent).toBe('Only on Studio');
  });

  it('a failed answer does not hold the person on the page: it moves on and says so, with Try again', async () => {
    view = await mount(setup({ failAnswers: true }).tree);
    await settle();
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.welcome');
    expect(view.container.querySelector('[data-flow-unsaved]')?.textContent).toContain('That answer was not saved');
  });

  it('closes with what was set up, and a Settings link for each page left for later', async () => {
    view = await mount(setup({}).tree);
    await settle();
    await next(); // name: done
    await click('Later'); // welcome: later
    await next(); // choose (skips itself only with mode everything: here it shows) -> done via Next
    await next(); // finish
    await next(); // appearance
    await next(); // look
    await settle();
    expect(view.container.querySelector('[data-onboarding-summary-set]')?.textContent).toContain('Name this machine');
    expect(view.container.querySelector('[data-onboarding-later-link="fake-pack.welcome"]')?.getAttribute('href')).toBe(
      '/d/fy_daemon_a/settings/fake-pack',
    );
  });

  it('ends on the last page of the run', async () => {
    view = await mount(setup({ search: '?phase=client' }).tree);
    await settle();
    await next();
    await next();
    await settle();
    expect(view.container.querySelector('[data-flow-end]')).not.toBeNull();
  });
});

describe('a page under its loading cover', () => {
  const only = (key: string, plugin = 'fake-pack') => {
    const id = key.split('.')[1] ?? key;
    return [
      {
        plugin,
        id,
        title: 'Slow thing',
        order: 1,
        side: 'daemon' as const,
        stepHost: true as const,
        state: 'pending' as const,
      },
    ];
  };
  const slow = (key: string, silenceMs: number) =>
    setup({ machines: [{ id: A, name: 'Studio', steps: only(key) }], silenceMs });

  it('shows the cover and locks Next until the page says it is ready', async () => {
    view = await mount(slow('fake-pack.silent', 10_000).tree);
    await settle();
    expect(view.container.querySelector('[data-flow-cover]')).not.toBeNull();
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(true);
    expect(view.container.querySelector('[data-flow-silent]')).toBeNull();
  });

  it('after a silence it offers to skip the step, and skipping moves on', async () => {
    view = await mount(slow('fake-pack.silent', 30).tree);
    await settle();
    await interact(() => new Promise(resolve => setTimeout(resolve, 60)));
    expect(view.container.querySelector('[data-flow-silent]')?.textContent).toContain('Still checking');
    await press('[data-flow-skip]');
    await settle();
    expect(view.container.querySelector('[data-flow-end]')).not.toBeNull();
  });

  it('a busy page locks Next and says what is happening', async () => {
    view = await mount(slow('fake-pack.busy', 10_000).tree);
    await settle();
    expect(view.container.querySelector('[data-flow-busy]')?.textContent).toBe('Installing…');
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(true);
  });
});

describe('Later is not final', () => {
  it('Later → Back → Next records done on the machine, once, after the later', async () => {
    const run = setup({});
    view = await mount(run.tree);
    await settle();
    await next(); // name
    await settle();
    await click('Later'); // welcome: later
    await settle();
    expect(pageKey()).toBe('fake-pack.choose');
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.welcome');
    await next(); // welcome: done
    await settle();
    await press('[data-step-back]');
    await next(); // again: nothing new is written
    await settle();
    expect(run.answers.filter(answer => answer.step === 'welcome').map(answer => answer.state)).toEqual([
      'later',
      'done',
    ]);
  });

  it('Later → Back → Next on a client page moves it from the later list onto the device ledger', async () => {
    const run = setup({ search: '?phase=client' });
    view = await mount(run.tree);
    await settle();
    await click('Later'); // appearance: later
    await settle();
    expect(pageKey()).toBe('fake-pack.look');
    expect(Object.keys((JSON.parse(run.store.get(CLIENT_LATER_KEY) ?? '{}') as { steps: object }).steps)).toEqual([
      'onboarding.appearance',
    ]);
    expect(run.store.get(CLIENT_LEDGER_KEY)).toBeUndefined();
    await press('[data-step-back]');
    expect(pageKey()).toBe('onboarding.appearance');
    await next();
    await settle();
    const ledger = JSON.parse(run.store.get(CLIENT_LEDGER_KEY) ?? '{}') as { steps: Record<string, unknown> };
    expect(Object.keys(ledger.steps)).toEqual(['onboarding.appearance']);
    await press('[data-step-back]');
    await next(); // a repeat writes nothing more
    const ledgerWrites = run.writes.filter(key => key === CLIENT_LEDGER_KEY);
    expect(ledgerWrites).toHaveLength(1);
  });
});

describe('answers the machine did not take', () => {
  const walkToEnd = async (): Promise<void> => {
    for (let count = 0; count < 6; count += 1) {
      await next();
      await settle();
    }
  };
  const unsavedSteps = (): (string | null)[] =>
    [...(view?.container.querySelectorAll('[data-flow-end] [data-flow-unsaved-step]') ?? [])].map(item =>
      item.getAttribute('data-flow-unsaved-step'),
    );

  it('keeps each failed answer per step to the end screen, which names them with a Try again', async () => {
    const failSteps = new Set(['name', 'finish']);
    const run = setup({ failSteps });
    view = await mount(run.tree);
    await settle();
    await walkToEnd();
    expect(view.container.querySelector('[data-flow-end]')).not.toBeNull();
    // choose and welcome were saved after name failed: they did not clear the name's failure.
    expect(unsavedSteps()).toEqual(['onboarding.name', 'fake-pack.finish']);
    expect(view.container.querySelector('[data-flow-end] [role="alert"]')?.textContent).toContain('2 answers');
    // Retry one step: only that one leaves the list.
    failSteps.delete('name');
    await press('[data-flow-retry-save="onboarding.name"]');
    await settle();
    expect(unsavedSteps()).toEqual(['fake-pack.finish']);
    expect(run.answers.filter(answer => answer.step === 'name')).toEqual([
      { daemon: A, plugin: 'onboarding', step: 'name', state: 'done' },
    ]);
    failSteps.delete('finish');
    await press('[data-flow-retry-save="fake-pack.finish"]');
    await settle();
    expect(unsavedSteps()).toEqual([]);
    expect(view.container.querySelector('[data-onboarding-summary]')).not.toBeNull();
  });

  it('one successful answer does not clear an earlier failure on the page either', async () => {
    const failSteps = new Set(['name']);
    view = await mount(setup({ failSteps }).tree);
    await settle();
    await next(); // name fails
    await settle();
    await next(); // welcome saves
    await settle();
    expect(view.container.querySelector('[data-flow-unsaved]')?.textContent).toContain('That answer was not saved');
  });
});

describe('a page that is still working, and a page that has gone', () => {
  const two = (first: string, second: string) =>
    setup({
      machines: [
        {
          id: A,
          name: 'Studio',
          steps: [first, second].map((id, index) => ({
            plugin: 'fake-pack',
            id,
            title: id,
            order: index + 1,
            side: 'daemon' as const,
            stepHost: true as const,
            state: 'pending' as const,
          })),
        },
      ],
    });

  it('locks Next, Back and Later while a save is slow, and the late save moves on exactly one page', async () => {
    view = await mount(two('slowsave', 'after').tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.slowsave');
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>('[data-flow-later]')?.disabled).toBe(true);
    await next(); // a locked button does nothing
    await settle();
    expect(pageKey()).toBe('fake-pack.slowsave');
    await interact(() => slow.finish());
    await settle();
    expect(pageKey()).toBe('fake-pack.after');
  });

  it('ignores a navigation callback from a page the run has already left', async () => {
    view = await mount(two('stale', 'after').tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.stale');
    const host = stale.host;
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.after');
    await interact(() => host?.next()); // the old page's late call: ignored
    await interact(() => host?.back());
    await interact(() => host?.skip('not-needed'));
    await settle();
    expect(pageKey()).toBe('fake-pack.after');
    expect(view.container.querySelector('[data-flow-end]')).toBeNull();
  });
});

describe('a legacy page beside a StepHost page', () => {
  it('draws the legacy page with no cover and Next enabled, records done on Next, and still covers the StepHost page', async () => {
    const run = setup({
      machines: [
        {
          id: A,
          name: 'Studio',
          steps: [
            { plugin: 'fake-pack', id: 'legacy', title: 'Legacy', order: 1, side: 'daemon', state: 'pending' },
            {
              plugin: 'fake-pack',
              id: 'silent',
              title: 'Silent',
              order: 2,
              side: 'daemon',
              stepHost: true,
              state: 'pending',
            },
          ],
        },
      ],
      silenceMs: 10_000,
    });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.legacy');
    expect(view.container.querySelector('[data-flow-cover]')).toBeNull();
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(false);
    expect(view.container.textContent).toContain('an old page that never calls ready');
    await next();
    await settle();
    expect(run.answers).toEqual([{ daemon: A, plugin: 'fake-pack', step: 'legacy', state: 'done' }]);
    expect(pageKey()).toBe('fake-pack.silent');
    expect(view.container.querySelector('[data-flow-cover]')).not.toBeNull();
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(true);
  });
});

const twoMachines = (): Machine[] => [
  { ...fakeDaemon(A, 'Studio'), id: A, name: 'Studio' },
  { ...fakeDaemon(B, 'Laptop'), id: B, name: 'Laptop' },
];

describe('another paired machine never holds the setup', () => {
  it('draws the first page once the other machine has had its grace, though its read never answers', async () => {
    const run = setup({ machines: twoMachines(), hangReads: new Set([B]), peerWaitMs: 30 });
    view = await mount(run.tree);
    await settle();
    await settle();
    expect(pageKey()).toBe('onboarding.name');
    expect(run.reads.map(read => read.daemon).sort()).toEqual([A, B]);
  });

  it('a setup retry asks for the interactive unlock on the machine being set up only', async () => {
    const refuse = new Set([A]);
    const run = setup({ machines: twoMachines(), hangReads: new Set([B]), refuseReads: refuse, peerWaitMs: 30 });
    view = await mount(run.tree);
    await settle();
    expect(view.container.querySelector('[data-flow-failed]')).not.toBeNull();
    refuse.delete(A);
    await press('[data-flow-retry]');
    await settle();
    await settle();
    expect(pageKey()).toBe('onboarding.name');
    const retried = run.reads.slice(-2);
    expect(retried.find(read => read.daemon === A)?.init).toEqual({ quiet: false });
    expect(retried.find(read => read.daemon === B)?.init).toEqual({});
  });
});

describe('answers go out one at a time per step', () => {
  it('Later → Back → Next sends done only after the later has landed', async () => {
    const held: (() => void)[] = [];
    const run = setup({
      gate: (state, step) =>
        state === 'later' && step === 'welcome'
          ? new Promise<void>(resolve => {
              held.push(resolve);
            })
          : undefined,
    });
    view = await mount(run.tree);
    await settle();
    await next(); // name
    await settle();
    await click('Later'); // welcome: later is held in flight
    await settle();
    await press('[data-step-back]');
    await next(); // welcome: done is queued behind it
    await settle();
    expect(run.arrived.filter(answer => answer.step === 'welcome')).toEqual([{ step: 'welcome', state: 'later' }]);
    await interact(() => {
      for (const release of held) release();
    });
    await settle();
    expect(run.arrived.filter(answer => answer.step === 'welcome').map(answer => answer.state)).toEqual([
      'later',
      'done',
    ]);
  });

  it('a newer intent replaces the queued one, and a failed later is not resent after a newer done', async () => {
    const failSteps = new Set(['welcome']);
    const run = setup({ failSteps });
    view = await mount(run.tree);
    await settle();
    await next(); // name
    await settle();
    await click('Later'); // welcome: later is refused
    await settle();
    expect(view.container.querySelector('[data-flow-unsaved]')).not.toBeNull();
    failSteps.delete('welcome');
    await press('[data-step-back]');
    await next(); // welcome: done goes out and lands
    await settle();
    expect(view.container.querySelector('[data-flow-unsaved]')).toBeNull();
    // There is nothing left to retry: the failed later was withdrawn by the newer intent.
    expect(run.answers.filter(answer => answer.step === 'welcome').map(answer => answer.state)).toEqual(['done']);
  });
});

describe('a flagless page that calls the host', () => {
  it('is reported once per kind of call, and still works', async () => {
    const reports: string[] = [];
    const run = setup({
      report: message => reports.push(message),
      machines: [
        {
          id: A,
          name: 'Studio',
          steps: [{ plugin: 'fake-pack', id: 'forgot', title: 'Forgot', order: 1, side: 'daemon', state: 'pending' }],
        },
      ],
    });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.forgot');
    expect(reports).toEqual([
      'onboarding: fake-pack.forgot called step.ready() but its manifest entry does not declare stepHost: true',
    ]);
  });

  it('a page that declares stepHost is never reported', async () => {
    const reports: string[] = [];
    view = await mount(setup({ report: message => reports.push(message) }).tree);
    await settle();
    expect(reports).toEqual([]);
  });
});
