/**
 * The Claude import pages inside the REAL setup flow (Onboarding's `createSetupFlow` / `FlowPage`), over a fake machine.
 * What is asserted is what the person can do: a skip is irreversible in the flow, so no page whose relevance depends on a
 * choice that Back can change may skip; Back and Later are never held by a page that only waits for input; and a run
 * that lost its memory in a reload still imports selectively. The flow screen is Onboarding's own (a tests-only carve-out in
 * `context-imports`); the pages are this plugin's own panels.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense, type ReactNode } from 'react';
import onboardingApp from '@ferretry/plugin-onboarding/app';
import onboardingManifest from '@ferretry/plugin-onboarding/manifest';
import app from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { importRoutes, scanOf } from '../../../fixtures/onboarding/scan.ts';
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

ensureDom();

const DAEMON = 'fy_daemon_a';
const IDS = [
  'import-choice',
  'import-settings',
  'import-model-set',
  'import-instructions',
  'import-skills',
  'import-mcp',
  'conversations',
  'import-run',
] as const;

interface Wire {
  readonly route: string;
  readonly body?: unknown;
}

function machineWith(options: { readonly answered?: readonly string[]; readonly refuse?: boolean }) {
  const wire: Wire[] = [];
  const steps = (manifest.onboarding ?? [])
    .filter(step => (IDS as readonly string[]).includes(step.id))
    .map(step => ({
      plugin: 'claude-code',
      id: step.id,
      title: step.title,
      order: step.order,
      side: 'daemon',
      group: 'Claude Code',
      stepHost: true,
      state: options.answered?.includes(step.id) === true ? 'done' : 'pending',
    }));
  const table: Record<string, unknown> = {
    ...importRoutes(scanOf()),
    'GET /v1/config/file': { text: 'binary: /fake/bin/claude\n', etag: 'e1' },
    ...(options.refuse === true
      ? {
          'POST /v1/runtimes/proposals': () => {
            throw new Error('This machine is busy.');
          },
        }
      : {}),
  };
  const client = {
    async call(route: string, request?: { body?: unknown }) {
      wire.push({ route, ...(request?.body === undefined ? {} : { body: request.body }) });
      if (route === 'GET /v1/onboarding') return { steps, complete: false, setUp: false };
      if (route.startsWith('POST /v1/onboarding')) return {};
      if (!(route in table)) throw new Error(`no route ${route}`);
      const answer = table[route];
      return typeof answer === 'function' ? (answer as (call: unknown) => unknown)(request ?? {}) : answer;
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, DAEMON);
  return { client, wire };
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

/** The real flow screen, with the real Claude pages placed in the `onboarding.step` slot. */
async function openFlow(options: { readonly answered?: readonly string[]; readonly refuse?: boolean } = {}) {
  const { client, wire } = machineWith(options);
  const harness = deviceViewHarness({ plugin: 'onboarding', fragments: [] });
  harness.setRows([fakeReachRow({ daemon: DAEMON, machine: 'Studio', client })]);
  const built = must(app.build?.({ manifest, client } as never), 'the claude-code app half');
  const panels = (manifest.ui?.panels ?? [])
    .filter(panel => panel.slot === 'onboarding.step')
    .map(
      (panel): PlacedPanel => ({
        plugin: 'claude-code',
        id: panel.id,
        view: props => {
          const Page = (built.panels as Record<string, unknown>)[panel.id] as ComponentType<PanelProps>;
          return <Page {...(props as PanelProps)} />;
        },
      }),
    );
  const onboardingScreens = must(
    onboardingApp.build?.({ manifest: onboardingManifest, client } as never)?.screens,
    'the onboarding screens',
  ) as Record<string, unknown>;
  const Flow = must(onboardingScreens.flow, 'the flow screen') as ComponentType;
  const tree: ReactNode = (
    <harness.Harness place="daemon">
      <WithSlotPanels slots={{ 'onboarding.step': panels }}>
        <Suspense fallback={null}>
          <Flow />
        </Suspense>
      </WithSlotPanels>
    </harness.Harness>
  );
  view = await mount(tree);
  await settle();
  return { wire };
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 40; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};
const root = (): HTMLElement => must(view, 'a mounted flow').container;
const press = async (selector: string): Promise<void> => {
  await interact(() => must(root().querySelector<HTMLElement>(selector), selector).click());
  await settle();
};
const pageKey = (): string | null | undefined =>
  root().querySelector('[data-flow-page]')?.getAttribute('data-flow-page');
const pageOf = (id: string): string => `claude-code.${id}`;
const next = () => press('[data-step-next]');
const back = () => press('[data-step-back]');
const items = (): string[] =>
  [...root().querySelectorAll('[data-found-item]')].map(node => node.getAttribute('data-found-item') ?? '');
const disabled = (selector: string): boolean =>
  must(root().querySelector<HTMLButtonElement>(selector), selector).disabled;
const proposals = (wire: readonly Wire[]) => wire.filter(call => call.route === 'POST /v1/runtimes/proposals');

describe('the Claude import pages inside the real setup flow', () => {
  test('(a) Import everything is ONE page; Back -> Choose brings the one-by-one pages back; nothing was recorded', async () => {
    const { wire } = await openFlow();
    expect(pageKey()).toBe(pageOf('import-choice'));
    await next(); // the default card is "Import everything": the five kind pages are passed over
    expect(pageKey()).toBe(pageOf('conversations'));
    expect(root().querySelector('[data-found-item]')).toBeNull();
    await next();
    expect(pageKey()).toBe(pageOf('import-run')); // the one import page
    // Back goes to the last page actually shown, never to a kind page that drew nothing.
    await back();
    expect(pageKey()).toBe(pageOf('conversations'));
    await back();
    expect(pageKey()).toBe(pageOf('import-choice'));
    // Nothing for the passed-over pages reached the machine (no answer, skipped or otherwise).
    // Only the two pages that were drawn (the choice, Conversations) were answered, both done: no skip, no kind page.
    const answered = wire.filter(call => call.route.startsWith('POST /v1/onboarding'));
    expect(answered.map(call => (call.body as { state: string }).state)).toEqual(['done', 'done']);
    await press('input[value="choose"]');
    await next();
    expect(pageKey()).toBe(pageOf('import-settings'));
    expect(items()).toContain('claude-code:settings');
  });

  test('selecting a choice with the arrow keys writes nothing and never leaves the page', async () => {
    const { wire } = await openFlow();
    expect(pageKey()).toBe(pageOf('import-choice'));
    const group = must(root().querySelector('[role="radiogroup"]'), 'the choice cards');
    for (const key of ['End', 'Home', 'ArrowRight', 'ArrowRight']) {
      // The key goes to the radio holding the focus (the checked one until an arrow has moved it).
      const focused = document.activeElement;
      const holder =
        focused instanceof HTMLInputElement && group.contains(focused)
          ? focused
          : must(group.querySelector<HTMLInputElement>('input:checked'), 'the checked card');
      await interact(
        () => void holder.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
      );
      await settle();
      expect(pageKey()).toBe(pageOf('import-choice'));
    }
    // The arrows moved the focus only: the card that was chosen still is, and Enter chooses the focused one.
    expect(root().querySelector('input[value="fresh"]:checked')).toBeNull();
    const landed = must(document.activeElement as HTMLInputElement | null, 'the focused card');
    await interact(
      () => void landed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    await settle();
    expect(root().querySelector('input[value="fresh"]:checked')).not.toBeNull();
    expect(wire.filter(call => call.route.startsWith('POST /v1/onboarding'))).toEqual([]);
    expect(root().querySelector('[data-flow-end]')).toBeNull();
  });

  test('"Start fresh" leaves nothing to import: the final page is passed over too, and Back can still change the mode', async () => {
    const { wire } = await openFlow();
    await press('input[value="fresh"]');
    await next();
    expect(pageKey()).toBe(pageOf('conversations'));
    const before = wire.filter(call => call.route.startsWith('POST /v1/onboarding')).length;
    await next(); // the import page has nothing to do: the run goes on to the end
    expect(pageKey()).toBeUndefined();
    // Only now, at the end, does the machine hear that the six passed-over pages were skipped (none left pending).
    const states = wire
      .filter(call => call.route.startsWith('POST /v1/onboarding'))
      .slice(before)
      .map(call => (call.body as { state: string }).state);
    expect(states.sort()).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    await back();
    expect(pageKey()).toBe(pageOf('conversations'));
    await back();
    expect(pageKey()).toBe(pageOf('import-choice'));
    await press('input[value="everything"]');
    await next();
    await next();
    expect(pageKey()).toBe(pageOf('import-run'));
    expect(root().querySelector('.cc-actions button')).not.toBeNull();
  });

  test('(b) after a reload mid-run, a left-out MCP server is in the skip list the import sends', async () => {
    // The machine already recorded the earlier pages, so the run resumes at MCP with no memory of the choice.
    await openFlow({
      answered: ['import-choice', 'import-settings', 'import-model-set', 'import-instructions', 'import-skills'],
    }).then(async ({ wire }) => {
      expect(pageKey()).toBe(pageOf('import-mcp'));
      expect(root().querySelector('[data-import-lost]')).toBeNull();
      expect(root().querySelector('[data-found-item="claude-code:mcp:issues"] input')).not.toBeNull();
      await press('[data-found-item="claude-code:mcp:issues"] input');
      await next(); // conversations
      await next(); // the final page
      expect(pageKey()).toBe(pageOf('import-run'));
      await press('input[value="everything"]');
      await press('.cc-actions button');
      const [sent] = proposals(wire).map(call => call.body as { change: { skip?: string[] } });
      expect(sent?.change.skip).toEqual(['claude-code:mcp:issues']);
    });
  });

  test('(c) Back and Later stay enabled on the final page before any write and after a refusal', async () => {
    const { wire } = await openFlow({
      answered: [
        'import-choice',
        'import-settings',
        'import-model-set',
        'import-instructions',
        'import-skills',
        'import-mcp',
      ],
      refuse: true,
    });
    expect(pageKey()).toBe(pageOf('conversations'));
    await next();
    expect(pageKey()).toBe(pageOf('import-run'));
    expect(disabled('[data-step-back]')).toBe(false);
    expect(disabled('[data-flow-later]')).toBe(false);
    await press('input[value="everything"]');
    await press('.cc-actions button');
    expect(proposals(wire)).toHaveLength(1);
    expect(root().querySelector('[data-import-refusal]')?.textContent).toContain('busy');
    expect(disabled('[data-step-back]')).toBe(false);
    expect(disabled('[data-flow-later]')).toBe(false);
  });

  test('(c) a pick on Conversations holds neither Back nor Later, and registers a save for Next instead of a button', async () => {
    await openFlow({
      answered: ['import-choice', 'import-settings', 'import-model-set', 'import-instructions', 'import-skills'],
    });
    await next(); // MCP → conversations
    expect(pageKey()).toBe(pageOf('conversations'));
    await press('input[value="off"]');
    expect(root().querySelector('[data-flow-page] .cc-step button')).toBeNull();
    expect(disabled('[data-step-back]')).toBe(false);
    expect(disabled('[data-flow-later]')).toBe(false);
  });

  test('(d) leaving Settings out and bringing it back with Back keeps the Models page', async () => {
    await openFlow();
    await press('input[value="choose"]');
    await next();
    expect(pageKey()).toBe(pageOf('import-settings'));
    await press('[data-found-item="claude-code:settings"] input'); // leave Settings out
    await next();
    expect(pageKey()).toBe(pageOf('import-model-set'));
    expect(root().querySelector('[data-needs-settings]')).not.toBeNull();
    expect(items()).toEqual([]);
    await back();
    expect(pageKey()).toBe(pageOf('import-settings'));
    await press('[data-found-item="claude-code:settings"] input'); // bring it back
    await next();
    expect(pageKey()).toBe(pageOf('import-model-set'));
    expect(root().querySelector('[data-needs-settings]')).toBeNull();
    expect(items().length).toBeGreaterThan(0);
  });
});
