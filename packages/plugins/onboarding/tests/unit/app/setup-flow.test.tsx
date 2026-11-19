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

const PAGES: Readonly<Record<string, (step: StepHost) => ReactNode>> = {
  'onboarding.name': step => <ReadyPage step={step} />,
  'onboarding.appearance': step => <ReadyPage step={step} />,
  'fake-pack.welcome': step => <WelcomePage step={step} />,
  'fake-pack.choose': step => <ChoosePage step={step} />,
  'fake-pack.finish': step => <FinishPage step={step} />,
  'fake-pack.look': step => <LookPage step={step} />,
  'fake-pack.silent': () => <SilentPage />,
  'fake-pack.busy': step => <BusyPage step={step} />,
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
}) {
  const machines = options.machines ?? [fakeDaemon(A, 'Studio')];
  const answers: { daemon: string; plugin: string; step: string; state: string }[] = [];
  const clients = new Map<string, PluginClient>();
  for (const machine of machines) {
    const client = {
      async call(route: string, request?: { params?: { plugin: string; stepId: string }; body?: { state: string } }) {
        if (route === 'GET /v1/onboarding') return { steps: machine.steps, complete: false, setUp: false };
        if (options.failAnswers === true) throw new Error('refused');
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
  return { tree, answers, writes, store };
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
    return [{ plugin, id, title: 'Slow thing', order: 1, side: 'daemon' as const, state: 'pending' as const }];
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
