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

/** The explicit Continue of a recovered chooser whose pick has a body to show (the pick alone never hands over). */
const proceed = () => press('[data-returned-continue]');

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

  test('a reload mid-run asks again, then the pages Everything does not need are passed over', async () => {
    // The run was left after the choice: the choice is answered, the memory of it is gone.
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-returned]')).not.toBeNull();
    await choose('everything');
    // A pick is local: the page that showed the choice stays (Next answers it), the pages after it are passed over.
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-returned]')).not.toBeNull();
    expect(run.written).toEqual([]);
    await next();
    expect(pageKey()).toBe('codex.conversations');
    expect(query('[data-import-kind]')).toBeNull();
    await next();
    expect(pageKey()).toBe('codex.import-run');
    expect(query('[data-import-run]')).not.toBeNull();
    expect(run.written.filter(entry => entry.state === 'skipped')).toEqual([]);
  });

  test('after a reload Everything is one page and Back from Conversations lands on the choice, which can change the answer', async () => {
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-settings');
    await choose('everything');
    expect(pageKey()).toBe('codex.import-settings');
    await next();
    expect(pageKey()).toBe('codex.conversations');
    // The page that showed the choice is in the Back trail, so Conversations has a Back.
    expect(query('[data-step-back]')).not.toBeNull();
    await back();
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-returned]')).not.toBeNull();
    expect(query('[data-choice="everything"] input:checked')).not.toBeNull();
    // Change the answer here: the checklist takes over this very page.
    await choose('choose');
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-found-item]')).toBeNull();
    await proceed();
    expect(query('[data-found-item]')).not.toBeNull();
    for (const id of KIND_STEPS) {
      expect(pageKey()).toBe(`codex.${id}`);
      await next();
    }
    expect(pageKey()).toBe('codex.conversations');
    expect(run.written.filter(entry => entry.state === 'skipped')).toEqual([]);
  });

  test('selecting a choice, arrow keys included, writes nothing and never leaves the page', async () => {
    // Only the import steps are still to ask: the case where every page after the choice is passed over.
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice', 'conversations', 'permission'] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-settings');
    await choose('fresh');
    expect(pageKey()).toBe('codex.import-settings');
    expect(run.written).toEqual([]);
    await arrow('Home');
    expect(query('[data-choice="everything"] input:checked')).not.toBeNull();
    expect(pageKey()).toBe('codex.import-settings');
    await arrow('End');
    expect(query('[data-choice="fresh"] input:checked')).not.toBeNull();
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-flow-end]')).toBeNull();
    expect(run.written).toEqual([]);
    // Only Next moves on and records: the shown page is done, the passed-over ones are told skipped at the end.
    await next();
    expect(run.written.find(entry => entry.step === 'import-settings')?.state).toBe('done');
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

  test('the recovered chooser holds on an arrow key in every mode: Customize with an empty kind records nothing', async () => {
    // import-mcp is the first pending step and the scan holds no MCP servers: the body would record a skip at once.
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice', ...KIND_STEPS.slice(0, 4)], noMcp: true });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-mcp');
    await arrow('ArrowRight'); // Customize
    expect(query('[data-choice="choose"] input:checked')).not.toBeNull();
    expect(query('[data-returned]')).not.toBeNull();
    expect(pageKey()).toBe('codex.import-mcp');
    expect(run.written).toEqual([]);
    // The chooser is still there to change the answer.
    await arrow('ArrowRight'); // Fresh
    expect(query('[data-choice="fresh"] input:checked')).not.toBeNull();
    expect(query('[data-returned]')).not.toBeNull();
    expect(run.written).toEqual([]);
    await arrow('Home');
    expect(query('[data-choice="everything"] input:checked')).not.toBeNull();
    expect(run.written).toEqual([]);
  });

  test('a recovered chooser with a non-empty scan keeps the chooser when Customize is picked, until Continue', async () => {
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    await arrow('ArrowRight'); // Customize
    expect(pageKey()).toBe('codex.import-settings');
    expect(query('[data-returned]')).not.toBeNull();
    expect(query('[data-found-item]')).toBeNull();
    await arrow('End'); // the person changes their mind: still possible
    expect(query('[data-choice="fresh"] input:checked')).not.toBeNull();
    expect(query('[data-returned-continue]')).toBeNull();
    expect(run.written).toEqual([]);
  });

  test('the recovered Everything choice returns on Back after Next', async () => {
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice'] });
    view = await mount(run.tree);
    await settle();
    await arrow('Home');
    expect(query('[data-returned]')).not.toBeNull();
    expect(run.written).toEqual([]);
    await next();
    expect(pageKey()).toBe('codex.conversations');
    await back();
    expect(query('[data-returned]')).not.toBeNull();
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
    await choose('everything');
    expect(query('[data-import-run]')).toBeNull();
    await proceed();
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

  test('after a reload the run page imports what the CURRENT picks say: an unticked item is in the skip list', async () => {
    // The run was left after the first four kind pages; the memory of every pick is gone, so the choice is asked again.
    const run = setup({ answered: [...START_AT_CHOICE, 'import-choice', ...KIND_STEPS.slice(0, 4)] });
    view = await mount(run.tree);
    await settle();
    expect(pageKey()).toBe('codex.import-mcp');
    expect(query('[data-returned]')).not.toBeNull();
    await choose('choose');
    expect(pageKey()).toBe('codex.import-mcp');
    expect(query('[data-found-item]')).toBeNull();
    await proceed();
    const box = query<HTMLInputElement>('[data-found-item="codex:mcp:notes"] input[type="checkbox"]');
    expect(box).not.toBeNull();
    await interact(() => box?.click());
    await next();
    expect(pageKey()).toBe('codex.conversations');
    await next();
    expect(pageKey()).toBe('codex.import-run');
    // The four pages that were answered before the reload are not reviewed again, and the page says so.
    expect(query('[data-import-unreviewed]')?.textContent).toContain('Settings');
    await press('[data-import-run]');
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]?.skip).toContain('codex:mcp:notes');
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
});
