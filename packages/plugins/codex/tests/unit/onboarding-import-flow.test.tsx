/// <reference lib="dom" />
/**
 * The Codex import pages INSIDE the real setup flow (`createSetupFlow`, reached through Onboarding's `flow` screen): what the
 * shell does with a page's `skip()` (it is persisted on the machine and the page is gone for the rest of the run) is exactly
 * what a unit over a recording host cannot see. So these walk the flow with Next / Back / Later the way a person does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import {
  deviceViewHarness,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  must,
  noteClientDaemon,
  type PlacedPanel,
  WithSlotPanels,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import onboardingApp from '@ferretry/plugin-onboarding/app';
import onboardingManifest from '@ferretry/plugin-onboarding/manifest';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';
import { APPLIED_SENTENCES, CODEX_FULL, MACHINE, scanOf, stagedFrom } from '../support/import-fixtures.ts';
import './../support/dom.ts';

const DAEMON = 'fy_daemon_codex';
const APPLY = 'POST /v1/runtimes/proposals/:proposalId/apply';
const FULL = scanOf(CODEX_FULL);
const KIND_STEPS = ['import-settings', 'import-model-set', 'import-instructions', 'import-skills', 'import-mcp'];

type Answer = (route: string, options?: { body?: unknown; quiet?: boolean }) => unknown;

/** One machine whose Codex steps `answered` are already done (a reload mid-run); the rest are still to ask. */
function setup(options: {
  readonly answered: readonly string[];
  readonly apply?: () => unknown;
  readonly noMcp?: boolean;
  /** Answers the scan read instead of the table (a scan that fails once, then works). */
  readonly scan?: () => unknown;
}) {
  const steps = (manifest.onboarding ?? []).map(step => ({
    plugin: 'codex',
    id: step.id,
    title: step.title,
    order: step.order,
    side: 'daemon' as const,
    group: 'Codex',
    stepHost: true,
    state: options.answered.includes(step.id) ? ('done' as const) : ('pending' as const),
  }));
  const written: { step: string; state: string }[] = [];
  const proposals: { skip?: string[] }[] = [];
  const table: Record<string, unknown> = {
    'GET /v1/runtimes/setup/scan': options.noMcp === true ? scanOf({ ...CODEX_FULL, mcpServers: [] }) : FULL,
    'GET /v1/codex/update': { installed: { state: 'ok', version: '0.9.0' } },
    'GET /v1/runtimes/machine': MACHINE,
    'GET /v1/config/file': { path: 'harness-codex.yaml', text: '', etag: 'e1', exists: true },
  };
  const answer: Answer = (route, request) => {
    if (route === 'GET /v1/runtimes/setup/scan' && options.scan !== undefined) return options.scan();
    if (route === 'GET /v1/onboarding') return { steps, complete: false, setUp: false };
    if (route === 'POST /v1/runtimes/proposals') {
      proposals.push((request as { body: { change: { skip?: string[] } } }).body.change);
      return stagedFrom({ body: request?.body });
    }
    if (route === APPLY)
      return (options.apply ?? (() => ({ outcome: 'executed', executor: 'setup', summary: APPLIED_SENTENCES })))();
    if (route in table) return table[route];
    // The one remaining write: a step's answer, `POST /v1/onboarding/:plugin/:stepId`.
    const params = (request as { params?: { stepId?: string }; body?: { state?: string } } | undefined) ?? {};
    // Any other route (a read this page does not depend on) answers empty and is never an answer to a step.
    if (params.params?.stepId === undefined) return {};
    written.push({ step: params.params?.stepId ?? '', state: params.body?.state ?? '' });
    return { ...steps[0], state: params.body?.state };
  };
  const client = {
    call: async (route: string, request?: { body?: unknown; quiet?: boolean }) => {
      const value = answer(route, request);
      if (value instanceof Error) throw value;
      return value;
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client, DAEMON);
  const codexPanels = must(app.build?.({ manifest, client } as never)?.panels, 'the codex panels');
  const flow = must(
    onboardingApp.build?.({ manifest: onboardingManifest, client } as never)?.screens?.flow,
    'the flow',
  );
  const harness = deviceViewHarness({ plugin: 'onboarding', fragments: [] });
  harness.setRows([fakeReachRow({ daemon: DAEMON, machine: 'Studio', client })]);
  const placed: PlacedPanel[] = (manifest.onboarding ?? []).map(step => ({
    plugin: 'codex',
    id: `step-${step.id}`,
    view: props => createElement(must(codexPanels[`step-${step.id}`], 'a step panel') as never, props as never),
  }));
  const tree = (
    <harness.Harness place="daemon">
      <WithSlotPanels slots={{ 'onboarding.step': placed }}>
        {createElement(flow as never, { params: {} })}
      </WithSlotPanels>
    </harness.Harness>
  );
  return { tree, written, proposals };
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
};
const query = <T extends HTMLElement>(selector: string): T | null => view?.container.querySelector<T>(selector) ?? null;
const press = async (selector: string): Promise<void> => {
  await interact(() => query(selector)?.click());
  await settle();
};
const next = () => press('[data-step-next]');
const back = () => press('[data-step-back]');
const pageKey = (): string | null | undefined => query('[data-flow-page]')?.getAttribute('data-flow-page');
/** A choice card of the import choice, by its id (the card's radio takes the press). */
const choose = async (id: 'everything' | 'choose' | 'fresh'): Promise<void> => {
  const radio = query<HTMLInputElement>(`[data-choice="${id}"] input`);
  expect(radio).not.toBeNull();
  await interact(() => radio?.click());
  await settle();
};

/** An arrow key on the choice's radio group: it moves AND selects, as a radio group does. */
const arrow = async (key: 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End'): Promise<void> => {
  const group = query('[role="radiogroup"]');
  expect(group).not.toBeNull();
  await interact(
    () => void group?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
  await settle();
};

/** An arrow key pressed on the page body (a checklist has no radio group): it must move nothing and write nothing. */
const arrowOnPage = async (key: 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End'): Promise<void> => {
  const target = query('[data-flow-page]') ?? view?.container;
  await interact(
    () => void target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
  await settle();
};

/** The checklist a kind page draws: every row's checkbox, and which are ticked. */
const boxes = (): HTMLInputElement[] => [
  ...(view?.container.querySelectorAll<HTMLInputElement>('[data-found-item] input[type="checkbox"]') ?? []),
];
/** No chooser of any kind is on screen (the recovered chooser is gone for good). */
const noChooser = (): void => {
  expect(query('[data-returned]')).toBeNull();
  expect(query('[data-returned-continue]')).toBeNull();
  expect(query('[data-codex-step="import-choice"]')).toBeNull();
  expect(query('[data-choice="everything"], [data-choice="choose"], [data-choice="fresh"]')).toBeNull();
};

const START_AT_CHOICE = ['installed', 'sign-in'];

describe('the Codex import pages in the setup flow', () => {
  test('Import everything is ONE page: no kind page is drawn, and Back -> Choose brings every checklist back', async () => {
    const run = setup({ answered: START_AT_CHOICE });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-choice');
    await next(); // Import everything (the default): the five kind pages are passed over
    expect(pageKey()).toBe('codex.conversations');
    expect(query('[data-import-kind]')).toBeNull();
    await next();
    expect(pageKey()).toBe('codex.import-run'); // the one import page
    // Back lands on the last page actually shown, never on a page that drew nothing.
    await back();
    expect(pageKey()).toBe('codex.conversations');
    await back();
    expect(pageKey()).toBe('codex.import-choice');
    // Nothing was recorded for the passed-over pages.
    expect(run.written.filter(entry => KIND_STEPS.includes(entry.step))).toEqual([]);
    await choose('choose');
    await next();
    for (const id of KIND_STEPS) {
      expect(pageKey()).toBe(`codex.${id}`);
      expect(query('[data-import-not-choosing]')).toBeNull();
      expect(query(`[data-codex-step="${id}"] [data-found-item]`)).not.toBeNull();
      await next();
    }
    expect(pageKey()).toBe('codex.conversations');
    await next();
    expect(pageKey()).toBe('codex.import-run');
    // Nothing the person went past was recorded as skipped on the machine.
    expect(run.written.filter(entry => entry.state === 'skipped')).toEqual([]);
  });

  test('a reload mid-run shows the Settings checklist as in Customize, every item ticked, never a chooser', async () => {
    // The run was left after the choice: the choice is answered, the memory of it is gone, Settings is the first pending page.
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-settings');
    noChooser();
    expect(boxes().length).toBeGreaterThan(0);
    expect(boxes().every(box => box.checked)).toBe(true);
    expect(query('[data-import-run]')).toBeNull();
    // Arrow keys write nothing and navigate nowhere.
    await arrowOnPage('ArrowRight');
    await arrowOnPage('End');
    expect(pageKey()).toBe('codex.import-settings');
    expect(run.written).toEqual([]);
    // Only the footer Next answers the page, and it records exactly the page that was shown.
    await next();
    expect(run.written.find(entry => entry.step === 'import-settings')?.state).toBe('done');
    expect(pageKey()).toBe('codex.import-model-set');
    noChooser();
    expect(boxes().length).toBeGreaterThan(0);
  });

  test('after a reload every kind page shows its checklist in turn, and the proposal has no skip nobody chose', async () => {
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    for (const id of KIND_STEPS) {
      expect(pageKey()).toBe(`codex.${id}`);
      expect(query(`[data-codex-step="${id}"] [data-found-item]`)).not.toBeNull();
      noChooser();
      await next();
    }
    expect(pageKey()).toBe('codex.conversations');
    await next();
    expect(pageKey()).toBe('codex.import-run');
    expect(query('[data-import-unreviewed]')).toBeNull();
    await press('[data-import-run]');
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]?.skip ?? []).toEqual([]);
    expect(run.written.filter(entry => entry.state === 'skipped')).toEqual([]);
  });

  test('after a reload, Back from Models reaches the Settings checklist again with its picks kept, and no chooser', async () => {
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-settings');
    const first = boxes()[0];
    const id = first?.closest('[data-found-item]')?.getAttribute('data-found-item');
    await interact(() => first?.click()); // untick the first row
    await next();
    expect(pageKey()).toBe('codex.import-model-set');
    expect(query('[data-step-back]')).not.toBeNull();
    await back();
    expect(pageKey()).toBe('codex.import-settings');
    noChooser();
    expect(query(`[data-found-item="${id}"] input`)?.hasAttribute('checked') ?? false).toBe(false);
    expect((query<HTMLInputElement>(`[data-found-item="${id}"] input`) as HTMLInputElement).checked).toBe(false);
  });

  test('the first choice (import-choice) selected by arrow keys writes nothing and stays', async () => {
    const run = setup({ answered: START_AT_CHOICE });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-choice');
    await arrow('ArrowRight');
    await arrow('ArrowRight');
    expect(query('[data-choice="fresh"] input:checked')).not.toBeNull();
    expect(pageKey()).toBe('codex.import-choice');
    expect(run.written).toEqual([]);
  });

  test('a refused import leaves Back and Later working, and the person can retry', async () => {
    let refuse = true;
    const run = setup({
      answered: [...START_AT_CHOICE, 'import-choice', ...KIND_STEPS, 'conversations'],
      apply: () =>
        refuse
          ? Object.assign(new Error('Codex is open in a terminal; close it and try again.'), {
              status: 409,
              code: 'busy',
            })
          : { outcome: 'executed', executor: 'setup', summary: APPLIED_SENTENCES },
    });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-run');
    noChooser();
    expect(query('[data-import-run]')).not.toBeNull();
    // Before anything is pressed nothing is held: the person may go Back or choose Later.
    expect(query<HTMLButtonElement>('[data-flow-later]')?.disabled).toBe(false);
    await press('[data-import-run]');
    expect(query('[data-import-refusal]')?.textContent).toContain('close it and try again');
    expect(query('[data-flow-busy]')).toBeNull();
    expect(query<HTMLButtonElement>('[data-flow-later]')?.disabled).toBe(false);
    expect(query<HTMLButtonElement>('[data-step-next]')?.disabled).toBe(false);
    refuse = false;
    await press('[data-import-run]');
    expect(query('[data-import-done]')).not.toBeNull();
    await act(async () => undefined);
  });

  test('after a reload the run page imports what the shown pages say: an unticked item is in the skip list, nothing else is', async () => {
    // The run was left after the first four kind pages; the memory of every pick is gone and MCP is the page to show.
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice', ...KIND_STEPS.slice(0, 4)] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-mcp');
    noChooser();
    const box = query<HTMLInputElement>('[data-found-item="codex:mcp:notes"] input[type="checkbox"]');
    expect(box).not.toBeNull();
    await interact(() => box?.click());
    await next();
    expect(pageKey()).toBe('codex.conversations');
    await next();
    expect(pageKey()).toBe('codex.import-run');
    // The four pages answered before the reload were not shown again: the page says so, and they are not left out.
    expect(query('[data-import-unreviewed]')?.textContent).toContain('Settings');
    expect(query('[data-import-unreviewed]')?.textContent).not.toContain('MCP');
    await press('[data-import-run]');
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]?.skip).toEqual(['codex:mcp:notes']);
  });

  test('after a reload a kind the scan holds nothing of passes itself over, and no chooser is drawn first', async () => {
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice', ...KIND_STEPS.slice(0, 4)], noMcp: true });
    view = await mount(run.tree);
    await settle();
    noChooser();
    expect(pageKey()).toBe('codex.conversations');
  });

  test('Import everything, Back, Customize: the pages show and Next records them done', async () => {
    const run = setup({ answered: START_AT_CHOICE });
    view = await mount(run.tree);
    await settle();
    await next(); // everything: the five kind pages are passed over
    expect(pageKey()).toBe('codex.conversations');
    await back();
    expect(pageKey()).toBe('codex.import-choice');
    await choose('choose');
    expect(pageKey()).toBe('codex.import-choice');
    await next();
    for (const id of KIND_STEPS) {
      expect(pageKey()).toBe(`codex.${id}`);
      await next();
    }
    for (const id of KIND_STEPS) expect(run.written.find(entry => entry.step === id)?.state).toBe('done');
  });

  test('Settings left out and then put back on Back keeps the models: the run page follows the final answers', async () => {
    const run = setup({ answered: START_AT_CHOICE });
    view = await mount(run.tree);
    await settle();
    await choose('choose');
    await next(); // settings
    expect(pageKey()).toBe('codex.import-settings');
    const settings = () => query<HTMLInputElement>('[data-found-item="codex:settings"] input[type="checkbox"]');
    await interact(() => settings()?.click()); // leave Settings out
    await next(); // models: says the settings were left out
    expect(pageKey()).toBe('codex.import-model-set');
    expect(query('[data-import-settings-left]')).not.toBeNull();
    await back();
    expect(pageKey()).toBe('codex.import-settings');
    await interact(() => settings()?.click()); // put Settings back
    await next();
    expect(query('[data-import-settings-left]')).toBeNull();
    for (let step = 0; step < 5; step += 1) await next(); // models, instructions, skills, mcp, conversations
    expect(pageKey()).toBe('codex.import-run');
    await press('[data-import-run]');
    const skip = run.proposals[0]?.skip ?? [];
    expect(skip).not.toContain('codex:settings');
    expect(skip).not.toContain('codex:model-set');
  });

  test('a kind whose scan failed on its page and was never shown is not a user exclusion: no skip, and no dependent dragged in', async () => {
    let scans = 0;
    const run = setup({
      answered: START_AT_CHOICE,
      scan: () => (++scans === 1 ? new Error('Scan unavailable on Settings') : FULL),
    });
    view = await mount(run.tree);
    await settle();
    await choose('choose');
    await next();
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-import-failed]')).not.toBeNull();
    expect(query('[data-found-item]')).toBeNull();
    await next(); // Settings is answered without ever being drawn
    expect(pageKey()).toBe('codex.import-model-set');
    await press('[data-import-look]'); // the retry works here
    expect(query('[data-found-item="codex:model-set"] input:checked')).not.toBeNull();
    expect(query('[data-import-settings-left]')).toBeNull();
    for (const id of [...KIND_STEPS.slice(1), 'conversations']) {
      expect(pageKey()).toBe(`codex.${id}`);
      await next();
    }
    expect(pageKey()).toBe('codex.import-run');
    // The page says Settings was not looked at; it does not hide it as a deliberate exclusion.
    expect(query('[data-import-unreviewed]')?.textContent).toContain('Settings');
    await press('[data-import-run]');
    expect(run.proposals).toHaveLength(1);
    const skip = run.proposals[0]?.skip ?? [];
    for (const id of ['codex:settings', 'codex:env', 'codex:model-set']) expect(skip).not.toContain(id);
    expect(skip).toEqual([]);
  });
});
