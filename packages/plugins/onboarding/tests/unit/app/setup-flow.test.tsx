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
import { REAL_PROVIDER_PRESET_CATALOG } from '@ferretry/plugin-logins/contract/testing';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAgentsPanel } from '../../../app/features/agents/agents-panel.tsx';
import { useScan } from '../../../app/features/setup-flow/machine-scan.ts';
import { createSetupFlow } from '../../../app/features/setup-flow/setup-flow.tsx';
import { sideOf } from '../../../contract/index.ts';
import { isComplete } from '../../../daemon/lib/steps.ts';
import { CLIENT_LATER_KEY } from '../../../app/features/setup-flow/client-later.ts';
import { CLIENT_LEDGER_KEY } from '../../../app/lib/client-ledger.ts';
import { fakeDaemon } from '../../fixtures/fake-steps/index.ts';
import { hostScan } from '../../fixtures/host-scan.ts';
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
/** r11 O1: a page that registers a save for Next; the test says how each run of it ends (`rejectWith` makes it reject once). */
const saves: {
  runs: number;
  rejectWith: string | undefined;
  throwWith: string | undefined;
  gate: Promise<void> | undefined;
} = {
  runs: 0,
  rejectWith: undefined,
  throwWith: undefined,
  gate: undefined,
};
function SavePage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => {
    step.ready();
    const run = async (): Promise<void> => {
      await saves.gate;
      const why = saves.rejectWith;
      saves.rejectWith = undefined;
      if (why !== undefined) throw new Error(why);
    };
    step.commit((): Promise<void> => {
      saves.runs += 1;
      const thrown = saves.throwWith;
      saves.throwWith = undefined;
      if (thrown !== undefined) throw new Error(thrown);
      return run();
    });
  }, [step]);
  return <p>pick something</p>;
}
/** Project setup's page (C59 O8-13): it commits like the real one and leaves where its project is. */
function ProjectSetupPage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => {
    step.ready();
    step.commit(async () => step.remember({ openLabel: 'Open Atlas', openHref: '/d/fy_daemon_a/projects/p1' }));
  }, [step]);
  return <p>folders</p>;
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

/** The first page of an import-shaped run: it remembers the mode the pages after it read. */
function PickPage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => step.ready(), [step]);
  return (
    <div>
      <button type="button" onClick={() => step.remember({ mode: 'everything' })}>
        Pick everything
      </button>
      <button type="button" onClick={() => step.remember({ mode: 'choose' })}>
        Pick choose
      </button>
    </div>
  );
}

/**
 * A page like a kind page of an import: with the mode `everything` it has nothing to ask and says `notNeeded()`; with no mode
 * (a reload dropped the memory) it asks again, and then follows the answer.
 */
function KindLikePage({ step, name }: { readonly step: StepHost; readonly name: string }): ReactNode {
  const [asked, setAsked] = useState(step.segment.mode !== undefined);
  const notNeeded = asked && step.segment.mode === 'everything';
  useEffect(() => {
    if (notNeeded) step.notNeeded();
    else step.ready();
  }, [step, notNeeded]);
  if (!asked)
    return (
      <button
        type="button"
        onClick={() => {
          step.remember({ mode: 'everything' });
          setAsked(true);
        }}
      >
        Ask everything
      </button>
    );
  return notNeeded ? null : <p>{name} checklist</p>;
}

/** The last page of an import-shaped run: like the real ones it leaves a memory of its own (a scan key) when it opens, which clears the marks behind it. */
function RunLikePage({ step }: { readonly step: StepHost }): ReactNode {
  useEffect(() => {
    step.remember({ scanRun: 'run-1' });
    step.ready();
  }, [step]);
  return <p>run</p>;
}

/** The machine the flow under test talks to, set by `setup`: the real picker and the scan reader below talk through its client. */
let flowClient: PluginClient | undefined;
/** The real AI picker (what the shell mounts), made for the flow's own client. */
function RealAgentsPage({ step }: { readonly step: StepHost }): ReactNode {
  const Panel = useMemo(() => createAgentsPanel(must(flowClient, 'a client')), []);
  return <Panel step={step} />;
}
/** Another reader of the machine's scan, as the Settings import is: it reads the machine afresh (`refresh`). */
function ScanReaderPage({ step }: { readonly step: StepHost }): ReactNode {
  useScan(must(flowClient, 'a client'), { run: 'settings-import', refresh: true });
  useEffect(() => step.ready(), [step]);
  return <p>another scan reader</p>;
}

const PAGES: Readonly<Record<string, (step: StepHost) => ReactNode>> = {
  'fake-pack.pick': step => <PickPage step={step} />,
  'fake-pack.alpha': step => <KindLikePage step={step} name="Alpha" />,
  'fake-pack.beta': step => <KindLikePage step={step} name="Beta" />,
  'fake-pack.run': step => <RunLikePage step={step} />,
  'onboarding.name': step => <ReadyPage step={step} />,
  'onboarding.agents': step => <RealAgentsPage step={step} />,
  'fake-pack.scan-reader': step => <ScanReaderPage step={step} />,
  'claude-code.installed': step => <ReadyPage step={step} />,
  'codex.installed': step => <ReadyPage step={step} />,
  'onboarding.appearance': step => <ReadyPage step={step} />,
  'fake-pack.welcome': step => <WelcomePage step={step} />,
  'fake-pack.choose': step => <ChoosePage step={step} />,
  'fake-pack.finish': step => <FinishPage step={step} />,
  'fake-pack.look': step => <LookPage step={step} />,
  'fake-pack.silent': () => <SilentPage />,
  'fake-pack.busy': step => <BusyPage step={step} />,
  'fake-pack.slowsave': step => <SlowSavePage step={step} />,
  'fake-pack.stale': step => <StalePage step={step} />,
  'fake-pack.save': step => <SavePage step={step} />,
  'fake-pack.after': step => <ReadyPage step={step} />,
  'fake-pack.legacy': () => <p>an old page that never calls ready</p>,
  'fake-pack.forgot': step => <ReadyPage step={step} />,
  'projects.folders': step => <ProjectSetupPage step={step} />,
};

/**
 * The slot harness hands every placed panel of a plugin the same subject, so a page that must be drawn ONCE (one that asks the
 * machine on mount) names the one panel that draws it; the other pages are drawn by whichever panel comes first, as before.
 */
const DRAWN_BY: Readonly<Record<string, string>> = {
  'onboarding.agents': 'agents-step',
  'fake-pack.scan-reader': 'step',
};

const stepPanel = (plugin: string, id: string): PlacedPanel => ({
  plugin,
  id,
  view: props => {
    const subject = String(props.subject);
    if ((DRAWN_BY[subject] ?? id) !== id) return null;
    return PAGES[subject]?.(props.step as StepHost) ?? null;
  },
});

interface Machine {
  readonly id: string;
  readonly name: string;
  readonly steps: ReturnType<typeof fakeDaemon>['steps'];
  /** The harnesses the daemon's registry says are installed (`GET /v1/onboarding` `harnesses`). */
  readonly harnesses?: readonly { readonly key: string; readonly label: string }[];
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
  /** Holds every steps-list read until the promise settles (the test releases it). */
  readonly holdSteps?: Promise<void>;
  readonly peerWaitMs?: number;
  /** What the machine's scan answers: nothing useful (the default), a refusal, or a Claude Code found here. */
  readonly scan?: 'fails' | 'finds';
  readonly report?: (message: string) => void;
  /** Holds a daemon answer until the returned promise settles (the test releases it). */
  readonly gate?: (state: string, step: string) => Promise<void> | undefined;
}) {
  const machines = options.machines ?? [fakeDaemon(A, 'Studio')];
  const answers: { daemon: string; plugin: string; step: string; state: string }[] = [];
  const reads: { daemon: string; init: unknown }[] = [];
  /** Every quiet scan the flow started, and how many steps-list reads had been asked when it started. */
  const scans: { daemon: string; at: number }[] = [];
  const arrived: { step: string; state: string }[] = [];
  const clients = new Map<string, PluginClient>();
  for (const machine of machines) {
    const client = {
      async call(route: string, request?: { params?: { plugin: string; stepId: string }; body?: { state: string } }) {
        if (route.startsWith('GET /v1/runtimes/setup/scan')) {
          scans.push({ daemon: machine.id, at: reads.length });
          if (options.scan === 'fails') throw new Error('the scan was refused');
          return options.scan === 'finds' ? hostScan(true) : {};
        }
        if (route === 'GET /v1/claude-code/update' || route === 'GET /v1/codex/update') return null;
        if (route === 'GET /v1/logins/presets') return REAL_PROVIDER_PRESET_CATALOG;
        if (route === 'GET /v1/onboarding') {
          reads.push({ daemon: machine.id, init: request });
          if (options.hangReads?.has(machine.id) === true) return new Promise(() => undefined);
          if (options.refuseReads?.has(machine.id) === true) throw new Error('unreachable');
          await options.holdSteps;
          return {
            steps: machine.steps,
            harnesses: (machine as Machine).harnesses ?? [],
            complete: false,
            setUp: false,
          };
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
  flowClient = clients.get(must(machines[0], 'a machine').id);
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
      stepPanel('onboarding', 'agents-step'),
      stepPanel('claude-code', 'step'),
      stepPanel('codex', 'step'),
      stepPanel('projects', 'step'),
    ],
  };
  const tree = (
    <harness.Harness place="daemon">
      <WithSlotPanels slots={slots}>
        <Flow params={{}} />
      </WithSlotPanels>
    </harness.Harness>
  );
  return { tree, answers, arrived, reads, scans, writes, store };
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
/** Every key and value a storage holds, sorted, so two moments can be compared whatever else the process wrote. */
const snapshotStorage = (area: Storage): readonly (readonly [string, string | null])[] =>
  Object.keys(area)
    .sort()
    .map(key => [key, area.getItem(key)] as const);

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
    expect(progressText()).toBe('Fake Pack · page 1 of 3');
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
    expect(progressText()).toBe('Fake Pack · page 2 of 2');
    // Back never lands on the skipped page.
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.welcome');
  });

  it('keeps the segment memory in memory only: no storage write carries it', async () => {
    // Another test file in the same process may have left entries: what is asserted is that THIS run added or changed none.
    const before = [snapshotStorage(window.localStorage), snapshotStorage(window.sessionStorage)];
    const run = setup({});
    view = await mount(run.tree);
    await settle();
    await next();
    await click('Everything');
    await next();
    await settle();
    expect(run.writes.filter(key => key !== CLIENT_LEDGER_KEY && key !== CLIENT_LATER_KEY)).toEqual([]);
    expect([...run.store.values()].join('')).not.toContain('everything');
    expect([snapshotStorage(window.localStorage), snapshotStorage(window.sessionStorage)]).toEqual(before);
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
    expect(progressText()).toBe('This device · page 1 of 1');
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

  it('closes with what was set up, and a quiet Settings link for each segment left for later', async () => {
    view = await mount(setup({}).tree);
    await settle();
    await next(); // name: done
    await click('Later'); // welcome: later
    await next(); // choose (skips itself only with mode everything: here it shows) -> done via Next
    await next(); // finish
    await next(); // appearance
    await next(); // look
    await settle();
    // It names the plugin (the progress bar's own name for it), never a page title.
    const summary = view.container.querySelector('[data-onboarding-summary-set]')?.textContent ?? '';
    expect(summary).toMatch(/^This machineFake Pack/u);
    expect(summary).not.toContain('Name this machine');
    expect(summary).not.toContain('Onboarding');
    // This device's own pages are in the summary too, named by their title, and the skipped one is a real button-link to Settings.
    expect(summary).toMatch(/This device\w/u);
    expect(view.container.querySelector('[data-onboarding-later-link="fake-pack"]')?.textContent).toMatch(
      /Set up|Finish/u,
    );
    expect(view.container.querySelector('[data-onboarding-later-link="fake-pack"]')?.getAttribute('href')).toBe(
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

  it('sends a skipped device page, and the closing Settings link of a device-only run, INSIDE the machine’s Settings', async () => {
    view = await mount(setup({ search: '?phase=client' }).tree);
    await settle();
    await click('Later'); // appearance: later
    await next(); // look
    await next(); // finish
    await settle();
    const hrefOf = (selector: string) => view?.container.querySelector(selector)?.getAttribute('href');
    expect(hrefOf('[data-onboarding-later-link="onboarding"]')).toBe('/d/fy_daemon_a/settings/device');
    expect(hrefOf('[data-onboarding-open-settings]')).toBe('/d/fy_daemon_a/settings/device');
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

describe('a page that is not needed for this run (contract rule 7)', () => {
  const importLike = (answered: readonly string[] = []): Machine => ({
    id: A,
    name: 'Studio',
    steps: ['pick', 'alpha', 'beta', 'run'].map((id, index) => ({
      plugin: 'fake-pack',
      id,
      title: id,
      order: index + 1,
      side: 'daemon' as const,
      group: 'Fake Pack',
      stepHost: true,
      state: answered.includes(id) ? ('done' as const) : ('pending' as const),
    })),
  });
  const chooseMode = (label: string) => click(label);
  const textOf = (): string => view?.container.textContent ?? '';

  it('Everything is ONE page: the next page is the run page, and the passed-over pages count for nothing', async () => {
    const run = setup({ machines: [importLike()] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.pick');
    await chooseMode('Pick everything');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.run');
    expect(progressText()).toBe('Fake Pack · page 2 of 2');
    // Back goes to the last page actually shown: not alpha or beta, which drew nothing.
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.pick');
  });

  it('nothing is recorded for a page that is not needed: no answer on the machine, no write on the device', async () => {
    const run = setup({ machines: [importLike()] });
    view = await mount(run.tree);
    await settle();
    await chooseMode('Pick everything');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.run');
    expect(run.answers).toEqual([{ daemon: A, plugin: 'fake-pack', step: 'pick', state: 'done' }]);
    expect(run.arrived).toEqual([{ step: 'pick', state: 'done' }]);
    expect(run.writes).toEqual([]);
  });

  it('only when the run ENDS is a page still passed over recorded (skipped), so the machine is not left pending', async () => {
    const run = setup({ machines: [importLike()] });
    view = await mount(run.tree);
    await settle();
    await chooseMode('Pick everything');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.run');
    expect(run.arrived).toEqual([{ step: 'pick', state: 'done' }]); // mid-run: nothing for alpha or beta
    await next(); // the run page: the run ends
    await settle();
    expect(pageKey()).toBeUndefined();
    expect(run.arrived.slice(0, 2)).toEqual([
      { step: 'pick', state: 'done' },
      { step: 'run', state: 'done' },
    ]);
    expect(run.arrived.slice(2).sort((a, b) => a.step.localeCompare(b.step))).toEqual([
      { step: 'alpha', state: 'skipped' },
      { step: 'beta', state: 'skipped' },
    ]);
    // The machine now reads as finished, and the step opener (which reopens the run for any pending machine step) stays shut.
    const after = importLike().steps.map(step => ({
      ...step,
      state: (run.answers.findLast(answer => answer.step === step.id)?.state ?? 'pending') as typeof step.state,
    }));
    expect(isComplete(after)).toBe(true);
    expect(after.filter(step => sideOf(step) === 'daemon' && step.state === 'pending')).toEqual([]);
    // Back from the end -> Choose: the pages are asked again, and a real answer replaces the skip.
    await press('[data-step-back]');
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.pick');
    await chooseMode('Pick choose');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.alpha');
    await next();
    await settle();
    expect(run.answers.filter(answer => answer.step === 'alpha').map(answer => answer.state)).toEqual([
      'skipped',
      'done',
    ]);
  });

  it('Back -> Choose: the answer changed, so the pages are asked again and appear; Back from the run page lands on the last of them', async () => {
    const run = setup({ machines: [importLike()] });
    view = await mount(run.tree);
    await settle();
    await chooseMode('Pick everything');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.run');
    await press('[data-step-back]');
    await chooseMode('Pick choose');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.alpha');
    expect(textOf()).toContain('Alpha checklist');
    expect(progressText()).toBe('Fake Pack · page 2 of 4');
    await next();
    expect(pageKey()).toBe('fake-pack.beta');
    await next();
    expect(pageKey()).toBe('fake-pack.run');
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.beta');
    // Customize BEFORE the end records the real answers on the pages, and never a skip.
    expect(run.answers.filter(answer => answer.step === 'alpha' || answer.step === 'beta')).toEqual([
      { daemon: A, plugin: 'fake-pack', step: 'alpha', state: 'done' },
      { daemon: A, plugin: 'fake-pack', step: 'beta', state: 'done' },
    ]);
    // And back to Everything again passes them over again.
    await press('[data-step-back]');
    await press('[data-step-back]');
    expect(pageKey()).toBe('fake-pack.pick');
    await chooseMode('Pick everything');
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.run');
  });

  it('a reload mid-run starts with no marks: the page asks again, and then the run passes over the rest', async () => {
    const reloaded = (): ReturnType<typeof setup> => setup({ machines: [importLike(['pick'])] });
    let run = reloaded();
    view = await mount(run.tree);
    await settle();
    // The choice is answered on the machine but its memory is gone: alpha asks again (no mark survived the reload).
    expect(pageKey()).toBe('fake-pack.alpha');
    expect(textOf()).toContain('Ask everything');
    await view.unmount();
    run = reloaded();
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('fake-pack.alpha');
    await chooseMode('Ask everything');
    await settle();
    // The page that asked was SHOWN, so its later `notNeeded()` is ignored: it stays, writes nothing, and only Next moves on.
    expect(pageKey()).toBe('fake-pack.alpha');
    expect(run.arrived).toEqual([]);
    expect(run.answers).toEqual([]);
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.run');
    expect(run.answers.map(answer => `${answer.step}:${answer.state}`)).toEqual(['alpha:done']);
  });
});

describe('Next saves the choice (contract rule 8, r11 O1)', () => {
  const steps = (...ids: string[]) =>
    setup({
      machines: [
        {
          id: A,
          name: 'Studio',
          steps: ids.map((id, index) => ({
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
  const errorText = (): string | null | undefined =>
    view?.container.querySelector('[data-flow-commit-error]')?.textContent;

  it('runs the registered save once on Next, records done once and moves on', async () => {
    saves.runs = 0;
    const run = steps('save', 'after');
    view = await mount(run.tree);
    await settle();
    expect(saves.runs).toBe(0);
    await next();
    await settle();
    expect(saves.runs).toBe(1);
    expect(pageKey()).toBe('fake-pack.after');
    expect(run.answers.map(answer => `${answer.step}:${answer.state}`)).toEqual(['save:done']);
  });

  it('a rejected save keeps the page, shows the error, records nothing, and Next runs the save again', async () => {
    saves.runs = 0;
    saves.rejectWith = 'The machine said no.';
    const run = steps('save', 'after');
    view = await mount(run.tree);
    await settle();
    await next();
    await settle();
    expect(saves.runs).toBe(1);
    expect(pageKey()).toBe('fake-pack.save');
    expect(errorText()).toBe('The machine said no.');
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(false);
    expect(run.answers).toEqual([]);
    await next();
    await settle();
    expect(saves.runs).toBe(2);
    expect(pageKey()).toBe('fake-pack.after');
    expect(errorText()).toBeUndefined();
    expect(run.answers.map(answer => `${answer.step}:${answer.state}`)).toEqual(['save:done']);
  });

  it('a save that throws while it is being prepared is a failed save: message, Next ready, retry runs it', async () => {
    saves.runs = 0;
    saves.throwWith = 'Could not prepare the request.';
    const run = steps('save', 'after');
    view = await mount(run.tree);
    await settle();
    await next();
    await settle();
    expect(saves.runs).toBe(1);
    expect(pageKey()).toBe('fake-pack.save');
    expect(errorText()).toBe('Could not prepare the request.');
    expect(view.container.querySelector('[data-flow-busy]')).toBeNull();
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(false);
    await next();
    await settle();
    expect(saves.runs).toBe(2);
    expect(pageKey()).toBe('fake-pack.after');
  });

  it('Next is locked and says Saving… while the save runs, and a second press does not run it twice', async () => {
    saves.runs = 0;
    let release: () => void = () => undefined;
    saves.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const run = steps('save', 'after');
    view = await mount(run.tree);
    await settle();
    await next();
    await settle();
    expect(view.container.querySelector('[data-flow-busy]')?.textContent).toBe('Saving…');
    expect(view.container.querySelector<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(true);
    await next();
    expect(saves.runs).toBe(1);
    expect(pageKey()).toBe('fake-pack.save');
    await interact(() => release());
    await settle();
    expect(saves.runs).toBe(1);
    expect(pageKey()).toBe('fake-pack.after');
    saves.gate = undefined;
  });

  it('Later never runs the save and records later', async () => {
    saves.runs = 0;
    const run = steps('save', 'after');
    view = await mount(run.tree);
    await settle();
    await press('[data-flow-later]');
    await settle();
    expect(saves.runs).toBe(0);
    expect(pageKey()).toBe('fake-pack.after');
    expect(run.answers.map(answer => `${answer.step}:${answer.state}`)).toEqual(['save:later']);
  });

  it('Back drops the save: nothing runs by leaving the page', async () => {
    saves.runs = 0;
    const run = steps('after', 'save');
    view = await mount(run.tree);
    await settle();
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.save');
    await press('[data-step-back]');
    await settle();
    expect(pageKey()).toBe('fake-pack.after');
    expect(saves.runs).toBe(0);
  });
});

describe('"Which AI do you want to use?" decides which harness segments the run walks', () => {
  /** The machine's steps; `states` names the ones the machine already recorded an answer for (by `<plugin>.<id>`). */
  const machine = (states: Readonly<Record<string, 'done' | 'found'>> = {}): Machine => ({
    id: A,
    name: 'Studio',
    harnesses: [
      { key: 'claude-code', label: 'Claude Code' },
      { key: 'codex', label: 'Codex' },
    ],
    steps: [
      ['onboarding', 'agents', 2],
      ['onboarding', 'name', 5],
      ['claude-code', 'installed', 20],
      ['codex', 'installed', 40],
    ].map(([plugin, id, order]) => ({
      plugin: String(plugin),
      id: String(id),
      title: String(id),
      order: Number(order),
      side: 'daemon' as const,
      group: String(plugin),
      stepHost: true,
      state: states[`${plugin}.${id}`] ?? ('pending' as const),
    })),
  });
  const told = (run: ReturnType<typeof setup>, plugin: string): string[] =>
    run.answers.filter(answer => answer.plugin === plugin).map(answer => answer.state);
  const box = (name: string): HTMLInputElement | null | undefined =>
    view?.container.querySelector<HTMLInputElement>(`[data-agent-row="${name}"] > label input`);

  it('is the first page, Claude only by default: the Codex pages are never drawn and nothing is recorded for the pick', async () => {
    const run = setup({ machines: [machine()] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    expect(box('claude-code')?.checked).toBe(true);
    await next();
    await settle();
    expect(pageKey()).toBe('onboarding.name');
    await next();
    await settle();
    expect(pageKey()).toBe('claude-code.installed');
    await next();
    await settle();
    expect(pageKey()).not.toBe('codex.installed');
    // The machine hears nothing about Codex until the run ends, and then only that it was skipped.
    expect(run.arrived.filter(row => row.step === 'installed').map(row => row.state)).not.toContain('pending');
  });

  it('ticking Codex too, from the first page, walks both segments in order; unticking Claude drops its pages', async () => {
    const run = setup({ machines: [machine()] });
    view = await mount(run.tree);
    await settle();
    await interact(() => box('codex')?.click());
    await next();
    await next();
    await settle();
    expect(pageKey()).toBe('claude-code.installed');
    await next();
    await settle();
    expect(pageKey()).toBe('codex.installed');

    // Back to the first page and drop Claude: Back from the name page, then forward again passes Claude over.
    await press('[data-step-back]');
    await press('[data-step-back]');
    await press('[data-step-back]');
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    await interact(() => box('claude-code')?.click());
    await next();
    await settle();
    expect(pageKey()).toBe('onboarding.name');
    await next();
    await settle();
    expect(pageKey()).toBe('codex.installed');
  });

  it('a run resumed after a Codex-only pick asks the picker again, so the pending Claude pages are not walked', async () => {
    // The machine recorded the picker (and the name) as answered, but the pick itself lived in memory and is gone.
    const run = setup({ machines: [machine({ 'onboarding.agents': 'done', 'onboarding.name': 'done' })] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    expect(box('claude-code')?.checked).toBe(true);
    await interact(() => box('claude-code')?.click());
    await interact(() => box('codex')?.click());
    await next();
    await settle();
    expect(pageKey()).toBe('codex.installed');
    await next();
    await settle();
    // Nothing of Claude was walked, and the machine hears of it only that it was skipped.
    expect(told(run, 'claude-code')).toEqual(['skipped']);
  });

  it('a resumed run whose harness pages were all answered does not ask the picker again', async () => {
    const run = setup({
      machines: [
        machine({
          'onboarding.agents': 'done',
          'onboarding.name': 'done',
          'claude-code.installed': 'done',
          'codex.installed': 'done',
        }),
      ],
    });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).not.toBe('onboarding.agents');
  });

  it('changing the pick after pages were answered keeps their state: nothing is told to the machine over them', async () => {
    // Claude was already found before this run; Codex is asked now.
    const found = setup({ machines: [machine({ 'claude-code.installed': 'found' })] });
    view = await mount(found.tree);
    await settle();
    await interact(() => box('claude-code')?.click());
    await interact(() => box('codex')?.click());
    await next();
    await next();
    await settle();
    expect(pageKey()).toBe('codex.installed');
    await next();
    await settle();
    expect(view?.container.querySelector('[data-flow-end]')).not.toBeNull();
    expect(told(found, 'claude-code')).toEqual([]);
    await view?.unmount();

    // Claude answered DURING this run, then the person goes back and unticks it: the answer stands, nothing more is told.
    const during = setup({ machines: [machine()] });
    view = await mount(during.tree);
    await settle();
    await next();
    await next();
    await settle();
    expect(pageKey()).toBe('claude-code.installed');
    await next();
    await settle();
    // The end page, then Back to Claude, to the name page, and to the picker.
    await press('[data-step-back]');
    await press('[data-step-back]');
    await press('[data-step-back]');
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    await interact(() => box('claude-code')?.click());
    await interact(() => box('codex')?.click());
    await next();
    await next();
    await settle();
    expect(pageKey()).toBe('codex.installed');
    await next();
    await settle();
    expect(view?.container.querySelector('[data-flow-end]')).not.toBeNull();
    expect(told(during, 'claude-code')).toEqual(['done']);
  });

  it('an empty pick holds Next and says so; Later leaves the question for another time', async () => {
    const run = setup({ machines: [machine()] });
    view = await mount(run.tree);
    await settle();
    await interact(() => box('claude-code')?.click());
    expect(view?.container.querySelector('[data-agent-none]')).not.toBeNull();
    await next();
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    expect(view?.container.querySelector('[data-flow-commit-error]')?.textContent).toContain('at least one');
    const answered = () => run.arrived.filter(row => row.step !== '');
    expect(answered()).toEqual([]);
    await press('[data-flow-later]');
    await settle();
    expect(pageKey()).not.toBe('onboarding.agents');
    expect(answered()).toEqual([{ step: 'agents', state: 'later' }]);
  });
});

describe("the machine's own setup is read the moment the flow opens (C59 O8-15)", () => {
  it('a first-time setup starts the scan before the steps list has answered, once', async () => {
    const run = setup({ hangReads: new Set([A]) });
    view = await mount(run.tree);
    await settle();
    // The steps list never answers, and the scan has been asked once, no later than the first steps read.
    expect(run.reads).toHaveLength(1);
    expect(run.scans).toEqual([{ daemon: A, at: 0 }]);
  });

  /** A first-time machine whose first page is a Claude Code page (a harness page the scan is for). */
  const claudeMachine = (): Machine => ({
    id: A,
    name: 'Studio',
    steps: [
      {
        plugin: 'claude-code',
        id: 'installed',
        title: 'Install Claude Code',
        order: 20,
        side: 'daemon' as const,
        group: 'Claude Code',
        stepHost: true,
        state: 'pending' as const,
      },
    ],
  });

  it('a steps list that arrives AFTER the scan settled starts no second scan: exactly one through the first harness page', async () => {
    let release: () => void = () => undefined;
    const run = setup({
      machines: [claudeMachine()],
      holdSteps: new Promise<void>(resolve => {
        release = resolve;
      }),
    });
    view = await mount(run.tree);
    await settle();
    // The scan has been asked and has settled while the steps list is still out.
    expect(run.scans).toHaveLength(1);
    release();
    await settle();
    await settle();
    expect(pageKey()).toBe('claude-code.installed');
    expect(run.scans).toHaveLength(1);
    await next();
    await settle();
    expect(run.scans).toHaveLength(1);
  });

  it('"Try again" on the steps list rereads the steps and never rescans', async () => {
    const refuse = new Set([A]);
    const run = setup({ machines: [claudeMachine()], refuseReads: refuse });
    view = await mount(run.tree);
    await settle();
    expect(view.container.querySelector('[data-flow-failed]')).not.toBeNull();
    expect(run.scans).toHaveLength(1);
    refuse.delete(A);
    await press('[data-flow-retry]');
    await settle();
    await settle();
    expect(pageKey()).toBe('claude-code.installed');
    expect(run.reads).toHaveLength(2);
    expect(run.scans).toHaveLength(1);
  });

  it('a device only pairing to an already set up machine reads no scan', async () => {
    const run = setup({ hangReads: new Set([A]), search: '?journey=pair' });
    view = await mount(run.tree);
    await settle();
    expect(run.scans).toEqual([]);
  });
});

describe('the AI picker reads only the scan the flow started (O8-15 B2)', () => {
  /** The picker first, then a page that is another reader of the machine's scan (the Settings import is one). */
  const pickerThenReader = (): Machine => ({
    id: A,
    name: 'Studio',
    harnesses: [{ key: 'claude-code', label: 'Claude Code' }],
    steps: [
      ['onboarding', 'agents', 2],
      ['fake-pack', 'scan-reader', 20],
    ].map(([plugin, id, order]) => ({
      plugin: String(plugin),
      id: String(id),
      title: String(id),
      order: Number(order),
      side: 'daemon' as const,
      group: String(plugin),
      stepHost: true,
      state: 'pending' as const,
    })),
  });
  const chips = (): (string | null | undefined)[] =>
    [...(view?.container.querySelectorAll('[data-agent-found]') ?? [])].map(chip =>
      chip.closest('[data-agent-row]')?.getAttribute('data-agent-row'),
    );

  it('a read ahead that FAILED: picker, another scan reader, picker again: the picker asks the machine for nothing', async () => {
    const run = setup({ machines: [pickerThenReader()], scan: 'fails' });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    // The flow's own read, and nothing from the picker.
    expect(run.scans).toHaveLength(1);
    await next();
    await settle();
    expect(pageKey()).toBe('fake-pack.scan-reader');
    // The other reader asks for itself (the flow draws the page more than once while it slides in: every draw asks).
    const withReader = run.scans.length;
    expect(withReader).toBeGreaterThan(1);
    await press('[data-step-back]');
    await settle();
    expect(pageKey()).toBe('onboarding.agents');
    expect(chips()).toEqual([]);
    expect(run.scans).toHaveLength(withReader);
  });

  it('a read ahead that FOUND Claude: the chip stands through another scan reader, and the picker asks nothing', async () => {
    const run = setup({ machines: [pickerThenReader()], scan: 'finds' });
    view = await mount(run.tree);
    await settle();
    expect(chips()).toEqual(['claude-code']);
    expect(run.scans).toHaveLength(1);
    await next();
    await settle();
    const withReader = run.scans.length;
    expect(withReader).toBeGreaterThan(1);
    await press('[data-step-back]');
    await settle();
    expect(chips()).toEqual(['claude-code']);
    expect(run.scans).toHaveLength(withReader);
  });
});

describe('the flow ends in project setup (C59 O8-13)', () => {
  const folders = {
    plugin: 'projects',
    id: 'folders',
    title: 'Add your projects',
    order: 90,
    side: 'client' as const,
    group: 'Projects',
    stepHost: true as const,
    state: 'pending' as const,
  };
  const atlas = (): Machine => {
    const machine = fakeDaemon(A, 'Studio', { withFake: false });
    return { ...machine, steps: [...machine.steps.map(step => ({ ...step, state: 'done' as const })), folders] };
  };
  const ledgerWithAppearance = (): Map<string, string> =>
    new Map([
      [CLIENT_LEDGER_KEY, JSON.stringify({ format: 1, steps: { 'onboarding.appearance': { at: AT, daemons: [A] } } })],
    ]);

  it('project setup is the LAST page, after the device pages, with its own bar segment and "Skip for now"', async () => {
    view = await mount(setup({ machines: [atlas()] }).tree);
    await settle();
    expect(pageKey()).toBe('onboarding.appearance');
    await next();
    await settle();
    expect(pageKey()).toBe('projects.folders');
    expect(progressText()).toBe('Projects · page 1 of 1');
    expect(buttonText('Skip for now')).toBeDefined();
    expect(buttonText('Later')).toBeUndefined();
  });

  it('finishing it ends on the project: the way on is "Open <project>", not the machine', async () => {
    view = await mount(setup({ machines: [atlas()], storage: ledgerWithAppearance() }).tree);
    await settle();
    expect(pageKey()).toBe('projects.folders');
    await next();
    await settle();
    expect(view.container.querySelector('[data-flow-end]')).not.toBeNull();
    expect(view.container.querySelector('[data-step-next]')?.textContent).toBe('Open Atlas');
  });

  it('Skip for now goes to the end page with the machine as the way on, and records later on this device', async () => {
    const run = setup({ machines: [atlas()], storage: ledgerWithAppearance() });
    view = await mount(run.tree);
    await settle();
    await click('Skip for now');
    await settle();
    expect(view.container.querySelector('[data-flow-end]')).not.toBeNull();
    expect(view.container.querySelector('[data-step-next]')?.textContent).toBe('Open this machine');
    const later = JSON.parse(run.store.get(CLIENT_LATER_KEY) ?? '{}') as { steps: object };
    expect(Object.keys(later.steps)).toEqual(['projects.folders']);
  });

  it('resumes in project setup: with everything else answered, the run starts on it, not at machine setup', async () => {
    view = await mount(setup({ machines: [atlas()], storage: ledgerWithAppearance() }).tree);
    await settle();
    expect(pageKey()).toBe('projects.folders');
    expect(view.container.querySelector('[data-step-back]')).toBeNull();
  });
});
