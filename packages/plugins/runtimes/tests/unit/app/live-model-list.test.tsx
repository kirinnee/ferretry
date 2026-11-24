import { afterEach, describe, expect, it } from 'bun:test';
import { type ChosenFerretAccount, NEW_FERRET_ACCOUNT_SLOT } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense } from 'react';
import half from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { loginList, loginView, runtimeCatalog, runtimeView } from './support/picker.ts';

/**
 * The live model list in the new-ferret picker: through the slot, as Ferrets' page sees it. The list is the ids the
 * login's provider listed; opening the picker asks the daemon once (it reads the provider only when the list is a day
 * old), "Refresh list" is the configure door and is offered only to a browser that holds it, and no read of a list ever
 * moves the runtime's default.
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

const REFRESH = 'POST /v1/logins/:loginId/model-list/refresh';
const FORCE = 'POST /v1/logins/:loginId/model-list/force';
const LOGIN = 'login-claude-a';
const DAY = 86_400_000;
const at = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString();

const choice = { efforts: [], available: true } as const;
const CATALOG = runtimeCatalog(
  runtimeView({
    wrapper: 'claude-a',
    models: {
      catalog: { id: 'kimi', label: 'Kimi', origin: 'built-in', customIds: true, docs: 'docs/model-catalog.md' },
      default: 'kimi-k3',
      choices: [
        { ...choice, id: 'kimi-k3', label: 'Kimi K3' },
        { ...choice, id: 'kimi-k3-turbo', label: 'Kimi K3 Turbo' },
      ],
    },
  }),
);
const READS = { 'GET /v1/runtimes': CATALOG, 'GET /v1/logins': loginList(loginView(LOGIN)) };
const granted = (configure: boolean) => ({
  capabilities: [
    {
      capability: 'fleet',
      configure,
      configureRefusal: configure ? 'granted' : 'device-not-granted',
    },
  ],
});
const answer = (outcome: string, ids: readonly string[], ageMs: number) => ({
  loginId: LOGIN,
  outcome,
  list: { fetchedAt: at(ageMs), complete: true, ids },
});

interface Page {
  chosen: ChosenFerretAccount | null | undefined;
}

const draw = async (routes: Record<string, unknown>, calls: Call[], page: Page) => {
  const client = { ...scripted(routes, calls), subscribe: () => () => undefined } as unknown as PluginClient;
  const built = half.build?.({ manifest, client }) as unknown as {
    panels: Record<string, (props: unknown) => unknown>;
  };
  const id = must(
    (manifest.ui?.panels ?? []).find(panel => panel.slot === NEW_FERRET_ACCOUNT_SLOT)?.id,
    'the new-ferret panel',
  );
  const Panel = must(built.panels[id], 'the panel') as unknown as ComponentType<Record<string, unknown>>;
  const props = {
    value: 'claude-a',
    onValueChange: () => undefined,
    onChosen: (chosen: ChosenFerretAccount | null) => {
      page.chosen = chosen;
    },
    fallbackId: 'agent-fallback',
    labelId: 'agent-label',
    fallbackPlaceholder: 'runtime',
    noAccounts: null,
  };
  const view = await mount(
    <Suspense fallback={null}>
      <Panel {...props} />
    </Suspense>,
  );
  mounted.push(view);
  await settle();
  return view;
};

const count = (calls: readonly Call[], route: string): number => calls.filter(call => call.route === route).length;

describe('the live model list in the new-ferret picker', () => {
  it('a stale list is read once in the background when the picker opens, and shown as the daemon answered it', async () => {
    const calls: Call[] = [];
    const page: Page = { chosen: undefined };
    await draw(
      {
        ...READS,
        'GET /v1/grants': granted(true),
        [REFRESH]: answer('refreshed', ['kimi-k3', 'kimi-k3-turbo'], 60_000),
      },
      calls,
      page,
    );
    expect(count(calls, REFRESH)).toBe(1);
    expect(count(calls, FORCE)).toBe(0);
    expect(calls.find(call => call.route === REFRESH)?.params).toEqual({ loginId: LOGIN });
    expect(page.chosen?.live?.list?.ids).toEqual(['kimi-k3', 'kimi-k3-turbo']);
  });

  it('keeps an old list the provider could not renew, so the picker can say it is old', async () => {
    const page: Page = { chosen: undefined };
    await draw(
      { ...READS, 'GET /v1/grants': granted(true), [REFRESH]: answer('kept', ['kimi-k3'], 3 * DAY) },
      [],
      page,
    );
    const fetchedAt = must(page.chosen?.live?.list, 'the held list').fetchedAt;
    expect(Date.now() - Date.parse(fetchedAt)).toBeGreaterThan(DAY);
  });

  it('a limited device is offered no Refresh list, and never calls the configure door', async () => {
    const calls: Call[] = [];
    const page: Page = { chosen: undefined };
    await draw(
      { ...READS, 'GET /v1/grants': granted(false), [REFRESH]: answer('current', ['kimi-k3'], 60_000) },
      calls,
      page,
    );
    expect(page.chosen?.live?.list?.ids).toEqual(['kimi-k3']);
    expect(page.chosen?.live?.refresh).toBeUndefined();
    expect(count(calls, FORCE)).toBe(0);
  });

  it('Refresh list reads at once, and the default does not move when the refresh adds a newer model', async () => {
    const calls: Call[] = [];
    const page: Page = { chosen: undefined };
    await draw(
      {
        ...READS,
        'GET /v1/grants': granted(true),
        [REFRESH]: answer('current', ['kimi-k3', 'kimi-k3-turbo'], 2 * DAY),
        [FORCE]: answer('refreshed', ['kimi-k3', 'kimi-k3-turbo', 'kimi-k4'], 1_000),
      },
      calls,
      page,
    );
    const before = must(page.chosen, 'the chosen runtime');
    expect(before.defaultModel).toBe('kimi-k3');
    await interact(() => must(before.live?.refresh, 'Refresh list').run());
    await settle();
    expect(count(calls, FORCE)).toBe(1);
    expect(count(calls, REFRESH)).toBe(1);
    const after = must(page.chosen, 'the chosen runtime after the refresh');
    expect(after.live?.list?.ids).toContain('kimi-k4');
    expect(after.defaultModel).toBe('kimi-k3');
    expect(after.models.map(model => model.id)).toEqual(['kimi-k3', 'kimi-k3-turbo']);
  });

  it('a login with no model list gives the picker nothing to draw, and a failed read is not an error', async () => {
    const none: Page = { chosen: undefined };
    await draw(
      { ...READS, 'GET /v1/grants': granted(true), [REFRESH]: { loginId: LOGIN, outcome: 'unavailable' } },
      [],
      none,
    );
    expect(none.chosen?.live).toBeUndefined();
    const down: Page = { chosen: undefined };
    await draw({ ...READS, 'GET /v1/grants': granted(true), [REFRESH]: new Error('offline') }, [], down);
    expect(down.chosen?.wrapper).toBe('claude-a');
    expect(down.chosen?.live).toBeUndefined();
  });
});
