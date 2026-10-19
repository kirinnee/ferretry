import { afterEach, beforeEach, describe, test } from 'bun:test';
import should from 'should';
import {
  FAST_COST_NOTE_MS,
  FastToggle,
  type FastToggleProps,
  fastObservationChanged,
} from '../../src/components/composer-fast.tsx';
import { ComposerRuntimeWithKeyboard } from '../../src/components/composer-runtime.tsx';
import { FastSwitch } from '../../src/components/fast-switch.tsx';
import type { RuntimeControlCommand, RuntimeModelCatalogSource } from '../../src/components/runtime-controls.tsx';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { FAST_COST_NOTE, FAST_COST_NOTE_KEY } from '../../src/lib/fast-mode.ts';
import type { RuntimeModelCatalog } from '../../src/lib/runtime-models.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });

type View = ReturnType<typeof sessionView>;
const view = (config: Partial<View['config']> = {}, state: Partial<View['state']> = {}, id = 's-1'): View =>
  sessionView(id, {
    config: { harness: 'claude', model: 'claude-opus-5-5', ...config },
    state: { status: 'running', turnState: 'your-turn', promptReady: true, ...state },
  });

const catalogOf = (fast: boolean | undefined): RuntimeModelCatalog => ({
  harness: 'claude',
  source: 'wrapper-inventory',
  choices: [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', reasoningEfforts: [], ...(fast === undefined ? {} : { fast }) },
  ],
});

const catalogs = (answer: () => Promise<RuntimeModelCatalog>): RuntimeModelCatalogSource => ({ load: answer });
const silent = catalogs(async () => catalogOf(undefined));

interface Sent {
  readonly sessionId: string;
  readonly command: RuntimeControlCommand;
  readonly requestId: string;
}

const recorder = (fail?: unknown) => {
  const sent: Sent[] = [];
  return {
    sent,
    api: {
      runtime: async (
        _daemon: DaemonConnection,
        sessionId: string,
        command: RuntimeControlCommand,
        requestId: string,
      ) => {
        sent.push({ sessionId, command, requestId });
        if (fail !== undefined) throw fail;
      },
    },
  };
};

const flush = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
  });
};

const toggleOf = (mounted: Mounted): HTMLButtonElement =>
  must(mounted.container.querySelector<HTMLButtonElement>('[data-fast-switch]'), 'the fast switch');
const statusOf = (mounted: Mounted): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>('[role="status"]'), 'the status node');
const markOf = (mounted: Mounted): string | undefined =>
  mounted.container.querySelector('[data-switch-state]')?.getAttribute('data-switch-state') ?? undefined;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const props = (overrides: Partial<FastToggleProps> & { sent?: ReturnType<typeof recorder> } = {}): FastToggleProps => ({
  view: view(),
  canControl: true,
  busy: false,
  api: (overrides.sent ?? recorder()).api,
  catalogs: silent,
  daemon: alpha,
  newRequestId: () => 'req-1',
  ...overrides,
});

const clearNote = () => globalThis.localStorage?.removeItem(FAST_COST_NOTE_KEY);
beforeEach(clearNote);
afterEach(clearNote);

describe('fastObservationChanged', () => {
  test('should confirm on a new value or on a re-report with a new timestamp alone', () => {
    should(fastObservationChanged({ fast: false, observedAt: 't1' }, { fast: true, observedAt: 't1' })).be.true();
    should(fastObservationChanged({ fast: true, observedAt: 't1' }, { fast: true, observedAt: 't2' })).be.true();
    should(fastObservationChanged({ fast: true, observedAt: 't1' }, { fast: true, observedAt: 't1' })).be.false();
  });
});

describe('FastSwitch', () => {
  test('should expose its state as a pressed button with a filled glyph while on', async () => {
    const on = await mount(<FastSwitch onPress={() => undefined} pressed />);
    const off = await mount(<FastSwitch onPress={() => undefined} pressed={false} />);

    should(toggleOf(on).getAttribute('aria-pressed')).equal('true');
    should(toggleOf(on).getAttribute('data-fast-switch')).equal('on');
    should(toggleOf(on).querySelector('svg')?.getAttribute('class')).containEql('fill-current');
    should(toggleOf(off).getAttribute('aria-pressed')).equal('false');
    should(toggleOf(off).querySelector('svg')?.getAttribute('class') ?? '').not.containEql('fill-current');
    should(toggleOf(off).textContent).equal('fast');
    await on.unmount();
    await off.unmount();
  });

  test('should name a mark on screen, aloud and on hover, and prefer a disabled reason for the tooltip', async () => {
    const marked = await mount(<FastSwitch mark="unconfirmed" onPress={() => undefined} pressed />);
    const refused = await mount(
      <FastSwitch
        disabled
        disabledReason="Busy."
        mark="switching"
        onPress={() => undefined}
        pressed={false}
        reasonId="why"
      />,
    );

    should(toggleOf(marked).textContent).containEql('unconfirmed');
    should(toggleOf(marked).getAttribute('aria-label')).containEql('could not confirm');
    should(toggleOf(marked).getAttribute('title')).containEql('Couldn’t confirm');
    should(toggleOf(refused).getAttribute('title')).equal('Busy.');
    should(toggleOf(refused).getAttribute('aria-describedby')).equal('why');
    should(toggleOf(refused).disabled).be.true();
    await marked.unmount();
    await refused.unmount();
  });

  test('should draw the form variant with a border and call back on press', async () => {
    const calls: string[] = [];
    const field = await mount(<FastSwitch onPress={() => calls.push('press')} pressed={false} variant="field" />);

    should(toggleOf(field).getAttribute('class')).containEql('border-border-strong');
    await interact(() => toggleOf(field).click());
    should(calls).deepEqual(['press']);
    await field.unmount();
  });
});

describe('FastToggle', () => {
  test('should show off by default and what the session was launched with before the harness reports', async () => {
    const off = await mount(<FastToggle {...props()} />);
    const launched = await mount(<FastToggle {...props({ view: view({ launchFast: true }) })} />);

    should(toggleOf(off).getAttribute('aria-pressed')).equal('false');
    should(toggleOf(launched).getAttribute('aria-pressed')).equal('true');
    await off.unmount();
    await launched.unmount();
  });

  test('should send the opposite of what is in force, with the per-click request id', async () => {
    const sent = recorder();
    const mounted = await mount(<FastToggle {...props({ sent })} />);

    await interact(() => toggleOf(mounted).click());

    should(sent.sent).deepEqual([{ sessionId: 's-1', command: { action: 'fast', fast: true }, requestId: 'req-1' }]);
    should(markOf(mounted)).equal('switching');
    should(toggleOf(mounted).getAttribute('aria-pressed')).equal('false');
    await mounted.unmount();
  });

  test('should turn fast off when it is on', async () => {
    const sent = recorder();
    const mounted = await mount(<FastToggle {...props({ sent, view: view({}, { observedFast: true }) })} />);

    await interact(() => toggleOf(mounted).click());

    should(sent.sent[0]?.command).deepEqual({ action: 'fast', fast: false });
    await mounted.unmount();
  });

  test('should settle on the harness report, even a re-report of the same value', async () => {
    const mounted = await mount(
      <FastToggle {...props({ view: view({}, { observedFast: true, observedModelAt: 't1' }) })} />,
    );
    await interact(() => toggleOf(mounted).click());
    should(markOf(mounted)).equal('switching');

    await mounted.render(<FastToggle {...props({ view: view({}, { observedFast: true, observedModelAt: 't2' }) })} />);

    should(markOf(mounted)).be.undefined();
    await mounted.unmount();
  });

  test('should give up with unconfirmed after the bound and keep naming the reported value', async () => {
    const mounted = await mount(
      <FastToggle {...props({ switchConfirmMs: 5, view: view({}, { observedFast: true }) })} />,
    );
    await interact(() => toggleOf(mounted).click());

    await interact(() => sleep(30));

    should(markOf(mounted)).equal('unconfirmed');
    should(toggleOf(mounted).getAttribute('aria-pressed')).equal('true');
    await mounted.unmount();
  });

  test('should clear a pending switch when the session goes busy', async () => {
    const mounted = await mount(<FastToggle {...props()} />);
    await interact(() => toggleOf(mounted).click());
    should(markOf(mounted)).equal('switching');

    await mounted.render(<FastToggle {...props({ busy: true })} />);

    should(markOf(mounted)).be.undefined();
    await mounted.unmount();
  });

  test('should mark a refused switch failed, say why, and let the next press clear it', async () => {
    const sent = recorder(new Error('no fast mode on this model'));
    const mounted = await mount(<FastToggle {...props({ sent })} />);

    await interact(() => toggleOf(mounted).click());

    should(markOf(mounted)).equal('failed');
    should(statusOf(mounted).textContent).equal('no fast mode on this model');
    should(toggleOf(mounted).getAttribute('title')).equal('no fast mode on this model');
    await mounted.unmount();
  });

  test('should explain a daemon that predates the control instead of a raw error', async () => {
    const sent = recorder({ status: 404, code: 'unknown_route' });
    const mounted = await mount(<FastToggle {...props({ sent })} />);

    await interact(() => toggleOf(mounted).click());

    should(statusOf(mounted).textContent).containEql('older than this web UI');
    await mounted.unmount();
  });

  test('should stringify a failure that is not an Error', async () => {
    const mounted = await mount(<FastToggle {...props({ sent: recorder('plain') })} />);

    await interact(() => toggleOf(mounted).click());

    should(statusOf(mounted).textContent).equal('plain');
    await mounted.unmount();
  });

  test('should disable with a spoken reason when read-only, finished or busy', async () => {
    const readOnly = await mount(<FastToggle {...props({ canControl: false })} />);
    const finished = await mount(<FastToggle {...props({ view: view({}, { status: 'completed' }) })} />);
    const busy = await mount(<FastToggle {...props({ busy: true })} />);
    const working = await mount(<FastToggle {...props({ view: view({}, { turnState: 'working' }) })} />);

    should(toggleOf(readOnly).disabled).be.true();
    should(readOnly.container.querySelector('.sr-only')?.textContent).containEql('Read-only');
    should(toggleOf(finished).disabled).be.true();
    should(finished.container.querySelector('.sr-only')?.textContent).containEql('finished');
    should(toggleOf(busy).disabled).be.true();
    should(toggleOf(working).disabled).be.true();
    for (const m of [readOnly, finished, busy, working]) await m.unmount();
  });

  test('should disable for a model the catalog says has no fast mode, and say which', async () => {
    const mounted = await mount(<FastToggle {...props({ catalogs: catalogs(async () => catalogOf(false)) })} />);
    await flush();

    should(toggleOf(mounted).disabled).be.true();
    should(mounted.container.querySelector('.sr-only')?.textContent).equal('Opus 5.5 has no fast mode.');
    await mounted.unmount();
  });

  test('should stay available when the catalog supports it, is silent, or cannot be read', async () => {
    const supported = await mount(<FastToggle {...props({ catalogs: catalogs(async () => catalogOf(true)) })} />);
    const unreadable = await mount(
      <FastToggle {...props({ catalogs: catalogs(async () => Promise.reject(new Error('x'))) })} />,
    );
    await flush();

    should(toggleOf(supported).disabled).be.false();
    should(toggleOf(unreadable).disabled).be.false();
    await supported.unmount();
    await unreadable.unmount();
  });

  test('should not read the catalog for a read-only origin or a finished session', async () => {
    let loads = 0;
    const counting = catalogs(async () => {
      loads += 1;
      return catalogOf(true);
    });
    const readOnly = await mount(<FastToggle {...props({ canControl: false, catalogs: counting })} />);
    const finished = await mount(
      <FastToggle {...props({ catalogs: counting, view: view({}, { status: 'completed' }) })} />,
    );
    await flush();

    should(loads).equal(0);
    await readOnly.unmount();
    await finished.unmount();
  });

  test('should say the cost once, the first time it is turned on, then never again', async () => {
    const first = await mount(<FastToggle {...props()} />);
    await interact(() => toggleOf(first).click());
    should(statusOf(first).textContent).equal(FAST_COST_NOTE);
    should(globalThis.localStorage?.getItem(FAST_COST_NOTE_KEY)).equal('1');
    await first.unmount();

    const second = await mount(<FastToggle {...props()} />);
    await interact(() => toggleOf(second).click());
    should(statusOf(second).textContent).equal('');
    await second.unmount();
  });

  test('should not say the cost when turning it off', async () => {
    const mounted = await mount(<FastToggle {...props({ view: view({}, { observedFast: true }) })} />);

    await interact(() => toggleOf(mounted).click());

    should(statusOf(mounted).textContent).equal('');
    should(globalThis.localStorage?.getItem(FAST_COST_NOTE_KEY) ?? null).be.null();
    await mounted.unmount();
  });

  test('should let the cost note go after a few seconds', async () => {
    should(FAST_COST_NOTE_MS).be.above(1000);
    const real = globalThis.setTimeout;
    const timers: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === FAST_COST_NOTE_MS) {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return real(fn, ms);
    }) as typeof setTimeout;
    try {
      const mounted = await mount(<FastToggle {...props()} />);
      await interact(() => toggleOf(mounted).click());
      should(statusOf(mounted).textContent).equal(FAST_COST_NOTE);

      await interact(() => {
        for (const fn of timers) fn();
      });

      should(statusOf(mounted).textContent).equal('');
      await mounted.unmount();
    } finally {
      globalThis.setTimeout = real;
    }
  });

  test('should reset the failure and note when the session changes', async () => {
    const mounted = await mount(<FastToggle {...props({ sent: recorder(new Error('nope')) })} />);
    await interact(() => toggleOf(mounted).click());
    should(markOf(mounted)).equal('failed');

    await mounted.render(<FastToggle {...props({ view: view({}, {}, 's-2') })} />);

    should(markOf(mounted)).be.undefined();
    await mounted.unmount();
  });
});

describe('the composer bar', () => {
  test('should draw the fast toggle after the model and reasoning chips', async () => {
    const mounted = await mount(
      <ComposerRuntimeWithKeyboard
        busy={false}
        canControl
        keyboardOpen={false}
        renderFast={() => <FastToggle {...props()} />}
        view={view()}
      />,
    );

    const row = must(mounted.container.querySelector('.fy-composer__runtime-row'), 'the chip row');
    const buttons = [...row.querySelectorAll('button')];
    should(buttons.map(button => button.className.includes('fy-composer__runtime'))).deepEqual([true, true, false]);
    should(buttons[2]?.getAttribute('data-fast-switch')).equal('off');
    await mounted.unmount();
  });
});
