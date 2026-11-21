import { afterEach, describe, expect, it } from 'bun:test';
import {
  FERRET_ACCOUNT_SLOTS,
  MOVE_ACCOUNT_SLOT,
  type ChosenFerretAccount,
  NEW_FERRET_ACCOUNT_SLOT,
} from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense, useState } from 'react';
import half from '../../../app/index.ts';
import { RuntimesChanged } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { choose, openBox, optionsOpen } from '../support/select-box.ts';
import { loginList, loginView, runtimeCatalog, runtimeView } from './support/picker.ts';

/**
 * The account picker as Ferrets' pages see it: through the slots they OFFER, drawn by the panels Runtimes CONTRIBUTES
 * to them. The panel is taken from the app half Runtimes builds, handed the props Ferrets' contract declares, and
 * answers only through those callbacks.
 */

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const READS = {
  'GET /v1/runtimes': runtimeCatalog(runtimeView({ wrapper: 'claude-a' }), runtimeView({ wrapper: 'codex-b' })),
  'GET /v1/logins': loginList(loginView('login-claude-a'), loginView('login-codex-b', 'needs_sign_in')),
};
const FEED = { stale: false, accounts: [{ agent: 'claude-a', fiveHourPercent: 42, fiveHourResetAt: 1 }] };

/** Usage's own refusal, as the shell's client throws it, unsent, for a plugin that is off on this daemon. */
const usageOff = (): Error =>
  Object.assign(new Error('Usage is paused on this daemon (off).'), { status: 0, code: 'plugin_paused' });

const panelFor = (
  slot: string,
  routes: Record<string, unknown>,
  calls: Call[] = [],
  subscribe: unknown = () => () => undefined,
) => {
  const client = { ...scripted(routes, calls), subscribe } as unknown as PluginClient;
  const built = half.build?.({ manifest, client }) as unknown as {
    panels: Record<string, (props: unknown) => unknown>;
  };
  const id = (manifest.ui?.panels ?? []).find(panel => panel.slot === slot)?.id;
  return must(built.panels[must(id, `a panel in ${slot}`)], `the panel in ${slot}`);
};

interface Page {
  value: string;
  chosen: ChosenFerretAccount | null | undefined;
}

const props = (page: Page, extra: Record<string, unknown> = {}) => ({
  value: page.value,
  onValueChange: (next: string) => {
    page.value = next;
  },
  onChosen: (chosen: ChosenFerretAccount | null) => {
    page.chosen = chosen;
  },
  fallbackId: 'agent-fallback',
  labelId: 'agent-label',
  fallbackPlaceholder: 'runtime',
  noAccounts: <p data-none="">No runtimes</p>,
  ...extra,
});

const draw = async (panel: (props: unknown) => unknown, page: Page, extra: Record<string, unknown> = {}) => {
  const Panel = panel as unknown as ComponentType<Record<string, unknown>>;
  const element = (
    <Suspense fallback={null}>
      <Panel {...props(page, extra)} />
    </Suspense>
  );
  const view = await mount(element);
  mounted.push(view);
  await settle();
  // The page re-renders with the draft the panel proposed, as a real page does.
  await view.render(
    <Suspense fallback={null}>
      <Panel {...props(page, extra)} />
    </Suspense>,
  );
  await settle();
  return view;
};

describe('Ferrets’ account slots and Runtimes’ panels', () => {
  it('every slot Ferrets offers has exactly one Runtimes panel, and the half builds each', () => {
    const slots = (manifest.ui?.panels ?? []).map(panel => panel.slot as string);
    for (const slot of FERRET_ACCOUNT_SLOTS) expect(slots.filter(candidate => candidate === slot)).toHaveLength(1);
    expect(slots).toContain(NEW_FERRET_ACCOUNT_SLOT);
    expect(slots).toContain(MOVE_ACCOUNT_SLOT);
    for (const slot of FERRET_ACCOUNT_SLOTS) expect(typeof panelFor(slot, {})).toBe('function');
  });
});

describe('the new-ferret account slot, Usage on', () => {
  it('lists each runtime under its harness, with health and Usage’s quota, and fills in the first usable one', async () => {
    const calls: Call[] = [];
    const page: Page = { value: '', chosen: undefined };
    const view = await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': FEED }, calls), page);
    await openBox(view.container);
    expect([...document.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual([
      'Claude',
      'Codex',
    ]);
    const rows = optionsOpen();
    expect(rows).toHaveLength(2);
    const claude = must(
      rows.find(row => row.textContent?.includes('claude-a')),
      'claude',
    );
    expect(claude.textContent).toContain('5h 42%');
    const codex = must(
      rows.find(row => row.textContent?.includes('codex-b')),
      'codex',
    );
    expect(codex.textContent).toContain('needs sign-in');
    expect(codex.textContent).not.toContain('5h');
    // The chosen runtime's quota is also drawn under the box, in its tone, with its reset time.
    expect(view.container.querySelector('[data-runtime-quota]')?.getAttribute('title')).toStartWith('resets in');
    expect(calls.map(call => call.route)).toContain('GET /v1/usage');
    expect(page.value).toBe('claude-a');
  });

  it('proposes a choice through the callbacks, and names it in Ferrets’ words rather than the picker’s record', async () => {
    const page: Page = { value: 'claude-a', chosen: undefined };
    const view = await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': FEED }), page);
    expect(page.chosen?.wrapper).toBe('claude-a');
    expect(page.chosen?.kind).toBe('claude-code');
    expect(Object.keys(page.chosen ?? {}).sort()).toEqual(['defaultModel', 'displayName', 'kind', 'models', 'wrapper']);
    await choose(view.container, 'codex-b');
    expect(page.value).toBe('codex-b');
  });

  it('carries each model’s fast-mode flag to the page: false stays false, true stays true, absent stays absent', async () => {
    const choice = { efforts: [], available: true } as const;
    const catalog = runtimeCatalog(
      runtimeView({
        wrapper: 'claude-a',
        models: {
          catalog: {
            id: 'claude',
            label: 'Claude',
            origin: 'built-in',
            customIds: false,
            docs: 'docs/model-catalog.md',
          },
          choices: [
            { ...choice, id: 'with-fast', label: 'With fast', fast: true },
            { ...choice, id: 'no-fast', label: 'No fast', fast: false },
            { ...choice, id: 'unknown-fast', label: 'Unknown fast' },
          ],
        },
      }),
    );
    const page: Page = { value: 'claude-a', chosen: undefined };
    await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/runtimes': catalog }), page);
    const models = must(page.chosen, 'a chosen account').models;
    expect(models.find(model => model.id === 'with-fast')?.fast).toBe(true);
    expect(models.find(model => model.id === 'no-fast')?.fast).toBe(false);
    const unknown = must(
      models.find(model => model.id === 'unknown-fast'),
      'the model with no fast flag',
    );
    expect('fast' in unknown).toBe(false);
  });

  it('a launch hint the page passes is used when that runtime is offered and usable', async () => {
    const page: Page = { value: '', chosen: undefined };
    await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': FEED }), page, { preferred: 'codex-b' });
    expect(page.value).toBe('codex-b');
  });

  it('draws the page’s own sentence when the machine has no runtime, and a typed fallback when the roster cannot be read', async () => {
    const none = await draw(
      panelFor(NEW_FERRET_ACCOUNT_SLOT, { 'GET /v1/runtimes': runtimeCatalog(), 'GET /v1/logins': loginList() }),
      { value: '', chosen: undefined },
    );
    expect(none.container.querySelector('[data-none]')).not.toBeNull();
    const broken = await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, {}), { value: '', chosen: undefined });
    expect(broken.container.querySelector('input#agent-fallback')).not.toBeNull();
    expect(broken.container.querySelector('[role="alert"]')?.textContent).toContain('Type a runtime name instead');
  });

  it('offers no health check on this page: starting a ferret asks nothing of the host beyond the stored verdicts', async () => {
    const calls: Call[] = [];
    const view = await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': FEED }, calls), {
      value: '',
      chosen: undefined,
    });
    expect(view.container.querySelector('[data-picker-health]')).toBeNull();
    expect(calls.some(call => call.route.startsWith('POST'))).toBe(false);
  });

  it('draws nothing for props that are not the slot’s, rather than a half-wired picker', async () => {
    const Panel = panelFor(NEW_FERRET_ACCOUNT_SLOT, READS) as unknown as ComponentType<Record<string, unknown>>;
    const view = await mount(
      <Suspense fallback={null}>
        <Panel subject="f1" />
      </Suspense>,
    );
    mounted.push(view);
    await settle();
    expect(view.container.querySelector('[data-runtime-select]')).toBeNull();
  });
});

describe('the new-ferret account slot, Usage off', () => {
  it('draws the picker without quota and without a complaint when Usage is off on the daemon', async () => {
    const page: Page = { value: '', chosen: undefined };
    const view = await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': usageOff() }), page);
    await openBox(view.container);
    expect(optionsOpen()).toHaveLength(2);
    expect(view.container.querySelector('[data-runtime-quota]')).toBeNull();
    expect(view.container.querySelector('[data-picker-advisory]')).toBeNull();
    expect(optionsOpen().some(option => option.textContent?.includes('needs sign-in'))).toBe(true);
    expect(page.value).toBe('claude-a');
  });

  it('says quota is missing, and keeps the picker, when Usage is on and its read fails', async () => {
    const view = await draw(
      panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': new Error('the feed is warming up') }),
      { value: '', chosen: undefined },
    );
    await openBox(view.container);
    expect(optionsOpen()).toHaveLength(2);
    expect(view.container.querySelector('[data-runtime-quota]')).toBeNull();
    expect(view.container.querySelector('[data-picker-advisory]')?.textContent).toContain(
      'Quota could not be read (the feed is warming up).',
    );
  });

  it('treats an answer that is not a usage feed as a failed read, not as zero quota', async () => {
    const view = await draw(panelFor(NEW_FERRET_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': { nope: true } }), {
      value: '',
      chosen: undefined,
    });
    expect(view.container.querySelector('[data-runtime-quota]')).toBeNull();
    expect(view.container.querySelector('[data-picker-advisory]')?.textContent).toContain('not a usage feed');
  });
});

describe('the move account slot', () => {
  it('offers only the runtimes of the harness the ferret is on, with Usage’s quota', async () => {
    const view = await draw(
      panelFor(MOVE_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': FEED }),
      { value: '', chosen: undefined },
      { harness: 'claude-code' },
    );
    await openBox(view.container);
    expect(optionsOpen().map(option => option.querySelector('[data-label]')?.textContent)).toEqual(['claude-a']);
    expect(optionsOpen()[0]?.textContent).toContain('5h 42%');
  });

  it('checks the logins again only when the owner presses Check now, then shows the new verdict', async () => {
    const calls: Call[] = [];
    const routes = {
      ...READS,
      'GET /v1/usage': usageOff(),
      'POST /v1/logins/login-codex-b/check': loginView('login-codex-b', 'ready'),
    };
    const view = await draw(
      panelFor(MOVE_ACCOUNT_SLOT, routes, calls),
      { value: '', chosen: undefined },
      { harness: 'codex' },
    );
    expect(calls.some(call => call.route.startsWith('POST'))).toBe(false);
    await openBox(view.container);
    expect(optionsOpen()[0]?.textContent).toContain('needs sign-in');
    await openBox(view.container); // close
    const button = must(view.container.querySelector('[data-picker-health] button'), 'Check now');
    await interact(() => (button as HTMLButtonElement).click());
    await settle();
    expect(calls.filter(call => call.route.startsWith('POST')).map(call => call.params?.loginId)).toContain(
      'login-codex-b',
    );
    await openBox(view.container);
    expect(optionsOpen()[0]?.textContent).not.toContain('needs sign-in');
  });

  it('tells the page which runtimes of that harness can run, once the roster is read, and says nothing if the page did not ask', async () => {
    const told: (readonly string[] | null)[] = [];
    await draw(
      panelFor(MOVE_ACCOUNT_SLOT, READS),
      { value: '', chosen: undefined },
      { harness: 'claude-code', onOffered: (wrappers: readonly string[] | null) => told.push(wrappers) },
    );
    expect(told.at(-1)).toEqual(['claude-a']);
    expect(told.filter(wrappers => wrappers?.length === 1)).toHaveLength(1);
    const quiet = await draw(
      panelFor(MOVE_ACCOUNT_SLOT, READS),
      { value: '', chosen: undefined },
      { harness: 'codex' },
    );
    await openBox(quiet.container);
    expect(optionsOpen()).toHaveLength(1);
  });

  it('does not tell a page the cached roster is the answer while a changed roster is still being read', async () => {
    // The panel's store belongs to the app half and outlives a mount, so a later mount finds the last catalog in it.
    const changed: ((event: { runtimes: string[] }) => void)[] = [];
    const subscribe = (event: { name: string }, handler: (event: { runtimes: string[] }) => void) => {
      if (event.name === RuntimesChanged.name) changed.push(handler);
      return () => undefined;
    };
    let reads = 0;
    let resolveRoster: (answer: unknown) => void = () => undefined;
    const routes = {
      ...READS,
      'GET /v1/runtimes': () =>
        ++reads === 1
          ? runtimeCatalog(runtimeView({ wrapper: 'claude-a' }))
          : new Promise(resolve => {
              resolveRoster = resolve;
            }),
    };
    const panel = panelFor(MOVE_ACCOUNT_SLOT, routes, [], subscribe);
    await draw(panel, { value: '', chosen: undefined }, { harness: 'claude-code' });
    expect(reads).toBe(1);
    await interact(async () => {
      for (const handler of changed) handler({ runtimes: ['claude-b'] });
    });
    await settle();
    expect(reads).toBe(2);

    const told: (readonly string[] | null)[] = [];
    await draw(
      panel,
      { value: '', chosen: undefined },
      { harness: 'claude-code', onOffered: (wrappers: readonly string[] | null) => told.push(wrappers) },
    );
    expect(told.filter(wrappers => wrappers !== null)).toEqual([]);
    expect(told.at(-1)).toBeNull();

    resolveRoster(runtimeCatalog(runtimeView({ wrapper: 'claude-a' }), runtimeView({ wrapper: 'claude-b' })));
    await settle();
    expect(told.at(-1)).toEqual(['claude-a', 'claude-b']);
  });

  it('draws nothing without the harness the move page owes it', async () => {
    const Panel = panelFor(MOVE_ACCOUNT_SLOT, READS) as unknown as ComponentType<Record<string, unknown>>;
    const view = await mount(
      <Suspense fallback={null}>
        <Panel {...props({ value: '', chosen: undefined })} />
      </Suspense>,
    );
    mounted.push(view);
    await settle();
    expect(view.container.querySelector('[data-runtime-select]')).toBeNull();
  });
});

describe('the move account slot on a page that keeps the chosen account in state', () => {
  it('settles: the choice is proposed once for a runtime, not again on every re-render the proposal causes', async () => {
    // Arrange: the move screen's shape — state set from onChosen with a fresh object, props rebuilt on every render.
    const Panel = panelFor(MOVE_ACCOUNT_SLOT, { ...READS, 'GET /v1/usage': FEED }) as unknown as ComponentType<
      Record<string, unknown>
    >;
    let renders = 0;
    let proposals = 0;
    function Page() {
      const [value, setValue] = useState('claude-a');
      const [, setChosen] = useState<ChosenFerretAccount | null>(null);
      renders += 1;
      return (
        <Suspense fallback={null}>
          <Panel
            fallbackId="agent-fallback"
            fallbackPlaceholder="runtime"
            harness="claude-code"
            labelId="agent-label"
            noAccounts={<p />}
            onChosen={(chosen: ChosenFerretAccount | null) => {
              proposals += 1;
              setChosen(chosen);
            }}
            onValueChange={setValue}
            value={value}
          />
        </Suspense>
      );
    }

    // Act: a render loop throws React's "maximum update depth" out of the act scope
    const view = await mount(<Page />);
    mounted.push(view);
    await settle();

    // Assert
    expect(proposals).toBeGreaterThan(0);
    expect(proposals).toBeLessThan(6);
    expect(renders).toBeLessThan(20);
  });
});
