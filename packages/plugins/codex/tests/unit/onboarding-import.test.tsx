/// <reference lib="dom" />
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { type StepHarness, stepHarness } from '@ferretry/plugin-onboarding/contract/testing';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';
import { ONE_WAY_WORDS } from '../../app/features/onboarding/import/conversations-page.tsx';
import { createRoot } from '../support/dom.ts';
import { CHANGE_ID, CODEX_FULL, MACHINE, scanOf, stagedFrom, APPLIED_SENTENCES } from '../support/import-fixtures.ts';

const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
});

type Call = { readonly route: string; readonly options?: { readonly body?: unknown; readonly quiet?: boolean } };
type Answer = (call: Call) => unknown;

const APPLY = `POST /v1/runtimes/proposals/:proposalId/apply`;

/** The routes an import step reads and writes, over the made-up machine. `extra` replaces any of them. */
const machine =
  (scan: unknown, extra: Record<string, Answer | unknown> = {}): Answer =>
  call => {
    const table: Record<string, Answer | unknown> = {
      'GET /v1/runtimes/setup/scan': scan,
      'GET /v1/claude-code/update': { installed: { state: 'ok', version: '2.1.0' } },
      'GET /v1/codex/update': { installed: { state: 'ok', version: '0.9.0' } },
      'GET /v1/runtimes/machine': MACHINE,
      'POST /v1/runtimes/proposals': (call: Call) => stagedFrom({ body: call.options?.body }),
      'PUT /v1/config/file': { outcome: 'applied' },
      [APPLY]: { outcome: 'executed', executor: 'setup', summary: APPLIED_SENTENCES },
      'GET /v1/config/file': { path: 'harness-codex.yaml', text: '', etag: 'e1', exists: true },
      ...extra,
    };
    const answer = table[call.route];
    return typeof answer === 'function' ? (answer as Answer)(call) : answer;
  };

async function mount(step: string, harness: StepHarness, answer: Answer) {
  const calls: Call[] = [];
  const half = app.build?.({
    manifest,
    client: {
      call: async (route: string, options?: Call['options']) => {
        const call: Call = { route, ...(options === undefined ? {} : { options }) };
        calls.push(call);
        const value = answer(call);
        if (value instanceof Error) throw value;
        return value;
      },
      subscribe: () => () => {},
    },
  } as never);
  const Panel = half?.panels?.[`step-${step}`];
  if (Panel === undefined) throw new Error('missing the step panel');
  const container = document.createElement('div');
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(Panel as never, { subject: `codex.${step}`, step: harness.host }));
  });
  await settle();
  return { container, calls };
}
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
};
const press = async (container: HTMLElement, selector: string) => {
  const button = container.querySelector<HTMLElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
  });
  await settle();
};
const busyLabels = (harness: StepHarness): (string | null)[] =>
  harness.calls.flatMap(call => (call.kind === 'busy' ? [call.label] : []));
const review = (harness: StepHarness, kind: string): unknown => {
  const held = harness.segment[`review.${kind}`];
  return typeof held === 'string' ? JSON.parse(held) : undefined;
};

const FULL = scanOf(CODEX_FULL);
const CHOOSE = { importMode: 'choose' } as const;

describe('the declared steps', () => {
  test('every Codex step is written against the host, so each declares stepHost', () => {
    const steps: readonly { id: string; stepHost?: boolean }[] = manifest.onboarding ?? [];
    expect(steps.length).toBe(11);
    expect(steps.every(step => step.stepHost === true)).toBe(true);
  });
});

describe('a kind page (choose what to import)', () => {
  test('shows what was found with what it becomes, the hooks line, and the Vault words; remembers the defaults without saving', async () => {
    const store = spyOn(Storage.prototype, 'setItem');
    const harness = stepHarness({ segment: CHOOSE });
    const { container, calls } = await mount('import-settings', harness, machine(FULL));
    expect(harness.decision).toBe('shown');
    const text = container.textContent ?? '';
    expect(text).toContain('Settings (4 keys)');
    expect(text).toContain('Becomes: Codex settings');
    expect(text).toContain('Not imported: Ferretry doesn’t use hooks');
    expect(text).toContain('NOTES_KEY');
    expect(text).toContain('kept in the Vault');
    expect(review(harness, 'settings')).toEqual({ left: [], env: [] });
    expect(harness.count('done')).toBe(0);
    expect(calls.some(call => call.route.startsWith('POST') || call.route.startsWith('PUT'))).toBe(false);
    // The run memory is in memory only: no browser storage is written by a page.
    expect(store).not.toHaveBeenCalled();
    store.mockRestore();
  });

  test('unticking a thing leaves its id out; ticking it back takes it again', async () => {
    const harness = stepHarness({ segment: CHOOSE });
    const { container } = await mount('import-skills', harness, machine(FULL));
    const box = (name: string) =>
      container.querySelector<HTMLInputElement>(`[data-found-item="codex:skill:${name}"] input[type="checkbox"]`);
    expect(box('deploy')).not.toBeNull();
    await act(async () => box('deploy')?.click());
    expect(review(harness, 'skills')).toEqual({ left: ['codex:skill:deploy'], env: [] });
    await act(async () => box('deploy')?.click());
    expect(review(harness, 'skills')).toEqual({ left: [], env: [] });
  });

  test('a GitHub-token variable stays unticked until the person ticks it, and is remembered by name only', async () => {
    const harness = stepHarness({ segment: CHOOSE });
    const { container } = await mount('import-settings', harness, machine(FULL));
    const token = container.querySelector<HTMLInputElement>('[data-found-token="GH_TOKEN"] input[type="checkbox"]');
    expect(token?.checked).toBe(false);
    await act(async () => token?.click());
    expect(review(harness, 'settings')).toEqual({ left: [], env: ['GH_TOKEN'] });
  });

  test('the model-set page says when the settings it comes from were left out', async () => {
    const harness = stepHarness({
      segment: { ...CHOOSE, 'review.settings': JSON.stringify({ left: ['codex:settings'], env: [] }) },
    });
    const { container } = await mount('import-model-set', harness, machine(FULL));
    expect(container.querySelector('[data-import-settings-left]')).not.toBeNull();
  });

  for (const importMode of ['everything', 'fresh'] as const)
    test(`${importMode}: it is passed over for this run (notNeeded, never skip: a skip would outlive a change of mind), draws nothing and reads nothing`, async () => {
      const harness = stepHarness({ segment: { importMode } });
      const { container, calls } = await mount('import-mcp', harness, machine(FULL));
      expect(harness.decision).toBe('passed-over');
      expect(harness.count('notNeeded')).toBe(1);
      expect(harness.count('skip')).toBe(0);
      expect(harness.count('done')).toBe(0);
      expect(container.querySelector('[data-found-item]')).toBeNull();
      expect(container.textContent).toBe('');
      expect(calls).toEqual([]);
    });

  test('a kind with nothing found skips itself', async () => {
    const harness = stepHarness({ segment: CHOOSE });
    await mount('import-mcp', harness, machine(scanOf({ settings: CODEX_FULL.settings as never })));
    expect(harness.skippedWhy).toBe('not-needed');
  });

  test('a machine that wants the passkey waits for the press, then shows the page and remembers its defaults', async () => {
    const harness = stepHarness({ segment: CHOOSE });
    // The quiet read is refused (an answer the app cannot read); the person's own press gets the scan.
    const { container } = await mount('import-mcp', harness, call =>
      call.route === 'GET /v1/runtimes/setup/scan' ? (call.options?.quiet === false ? FULL : {}) : machine(FULL)(call),
    );
    expect(harness.decision).toBe('shown');
    expect(container.querySelector('[data-import-look]')).not.toBeNull();
    expect(review(harness, 'mcp')).toBeUndefined();
    await press(container, '[data-import-look]');
    expect(container.querySelector('[data-found-item="codex:mcp:notes"]')).not.toBeNull();
    expect(review(harness, 'mcp')).toEqual({ left: [], env: [] });
  });
});

describe('conversations', () => {
  test('is one sentence and no choice: no cards, no button, nothing asked, nothing written, never names Claude', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('conversations', harness, machine(FULL));
    expect(container.querySelector('[data-conversations-words]')?.textContent).toBe(ONE_WAY_WORDS);
    expect(ONE_WAY_WORDS.match(/[.!?]/gu)?.length).toBe(1);
    expect(harness.decision).toBe('shown');
    expect(harness.hasCommit).toBe(false);
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.textContent).not.toContain('Show them here');
    expect(container.textContent?.toLowerCase()).not.toContain('claude');
    expect(calls.filter(call => call.route === 'PUT /v1/config/file')).toEqual([]);
    expect(calls.filter(call => call.route === 'GET /v1/config/file')).toEqual([]);
  });

  test('its demo is generic words, never a made-up count that reads as found', async () => {
    const { container } = await mount('conversations', stepHarness(), machine(FULL));
    const demo = container.querySelector('[data-demo="conversations"]');
    expect(demo?.textContent).toContain('an example, not your conversations');
    expect(container.textContent).not.toContain('3 conversations');
  });
});

describe('the what-to-bring-over demo', () => {
  const demoLines = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('[data-demo] .ob-demo__line')].map(line => line.textContent ?? '');

  test('shows what the scan really found, kind by kind', async () => {
    const { container } = await mount('import-choice', stepHarness(), machine(FULL));
    const lines = demoLines(container);
    expect(lines[0]).toBe('› import everything');
    expect(lines).toContain('✓ settings');
    expect(lines).not.toContain('✓ the kinds Codex keeps');
  });

  test('on an empty machine it says nothing was found, and ticks nothing', async () => {
    const { container } = await mount('import-choice', stepHarness(), machine(scanOf({})));
    expect(demoLines(container)).toEqual(['› import everything', '· nothing found on this computer']);
    expect(container.querySelector('[data-demo]')?.getAttribute('aria-label')).toBe('Nothing was found to bring over');
  });

  test('before the scan is read it is generic example words, not a found list', async () => {
    const { container } = await mount('import-choice', stepHarness(), call =>
      call.route === 'GET /v1/runtimes/setup/scan' ? {} : machine(FULL)(call),
    );
    expect(demoLines(container).join(' ')).toContain('an example');
  });
});

describe('import-run', () => {
  const proposal = (
    calls: readonly Call[],
  ): { kind: string; include: string[]; skip?: string[]; names?: Record<string, string> } =>
    (
      (calls.find(call => call.route === 'POST /v1/runtimes/proposals')?.options?.body ?? { change: {} }) as {
        change: never;
      }
    ).change;

  test('everything: one page, nothing left out, the change names no hooks, and Next is held only while it is being brought over', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    expect(harness.decision).toBe('shown');
    expect(busyLabels(harness)).toEqual([]);
    // The same page as Claude Code's: the count, what Next does, the name, Import and Skip the import.
    expect(container.querySelector('[data-import-count]')?.textContent).toMatch(
      /^Bringing \d+ items?\. Hooks are never imported\.$/u,
    );
    // Next is held while the page waits for its own Import (contract rule 9): Import and the footer's Later are the only exits.
    expect(harness.calls.filter(call => call.kind === 'holdNext').at(-1)).toEqual({ kind: 'holdNext', held: true });
    // One action: leaving is the flow footer's Later / Next, so the page draws no second "skip" button.
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Import']);
    expect(calls.some(call => call.route === 'POST /v1/runtimes/proposals')).toBe(false);
    await press(container, '[data-import-run]');
    const change = proposal(calls);
    expect(change).toEqual({ kind: 'setup.import', include: ['codex'], names: { codex: 'codex-default' } });
    expect(JSON.stringify(change)).not.toMatch(/hook/iu);
    const apply = calls.find(call => call.route === APPLY);
    expect(apply).toBeDefined();
    expect(busyLabels(harness)).toEqual(['Importing…', null]);
    expect(harness.count('done')).toBe(1);
    expect(container.querySelector('[data-import-results]')?.textContent).toContain('mcp/notes.yaml');
    expect(harness.calls.filter(call => call.kind === 'holdNext').at(-1)).toEqual({ kind: 'holdNext', held: false });
    void CHANGE_ID;
  });

  test('choose: what the pages left out is the skip list; settings out takes the models they name; a kind never shown is not left out, only said', async () => {
    const harness = stepHarness({
      segment: {
        ...CHOOSE,
        'review.settings': JSON.stringify({ left: ['codex:settings'], env: [] }),
        'review.skills': JSON.stringify({ left: ['codex:skill:deploy'], env: [] }),
        'review.mcp': JSON.stringify({ left: [], env: [] }),
        'review.instructions': JSON.stringify({ left: [], env: [] }),
      },
    });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    // The model-set kind was never shown (a reload since): nobody left its profiles out, so they stay, and the page says so.
    expect(container.querySelector('[data-import-unreviewed]')?.textContent).toContain('Models');
    await press(container, '[data-import-run]');
    const change = proposal(calls);
    expect([...(change.skip ?? [])].sort()).toEqual(['codex:settings', 'codex:model-set', 'codex:skill:deploy'].sort());
    expect(change.include).toEqual(['codex']);
    expect(JSON.stringify(change)).not.toMatch(/hook/iu);
  });

  test('choose with a GitHub token ticked sends that name only, and only while the environment is brought', async () => {
    const harness = stepHarness({
      segment: {
        ...CHOOSE,
        'review.settings': JSON.stringify({ left: [], env: ['GH_TOKEN'] }),
        'review.model-set': JSON.stringify({ left: [], env: [] }),
        'review.instructions': JSON.stringify({ left: [], env: [] }),
        'review.skills': JSON.stringify({ left: [], env: [] }),
        'review.mcp': JSON.stringify({ left: [], env: [] }),
      },
    });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    await press(container, '[data-import-run]');
    expect((proposal(calls) as { tickedEnv?: string[] }).tickedEnv).toEqual(['GH_TOKEN']);
  });

  test('starting fresh is passed over for this run (notNeeded, never skipped) and reads nothing', async () => {
    const harness = stepHarness({ segment: { importMode: 'fresh' } });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    expect(harness.decision).toBe('passed-over');
    expect(harness.count('skip')).toBe(0);
    expect(container.textContent).toBe('');
    expect(calls).toEqual([]);
  });

  test('Codex not on this machine, or nothing found: it skips', async () => {
    const gone = stepHarness({ segment: { importMode: 'everything' } });
    await mount('import-run', gone, machine(scanOf('absent')));
    expect(gone.skippedWhy).toBe('not-needed');
    const empty = stepHarness({ segment: { importMode: 'everything' } });
    await mount('import-run', empty, machine(scanOf({})));
    expect(empty.skippedWhy).toBe('not-needed');
  });

  test('a runtime Codex already has is added to: no name is asked for or sent', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    const { container, calls } = await mount(
      'import-run',
      harness,
      machine(scanOf(CODEX_FULL, { duplicate: 'codex-main' })),
    );
    expect(container.querySelector('[data-runtime-name]')).toBeNull();
    expect(container.querySelector('[data-import-existing]')?.textContent).toBe(
      'A runtime already uses this setup, so no second one is added.',
    );
    await press(container, '[data-import-run]');
    expect(proposal(calls).names).toBeUndefined();
  });

  test('an empty name is refused before anything is sent', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    const input = container.querySelector<HTMLInputElement>('[data-runtime-name]');
    expect(input?.value).toBe('codex-default');
    await act(async () => {
      if (input !== null) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        set?.call(input, '  ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(container.querySelector('[data-import-name-problem]')?.textContent).toBe('Give the runtime a name.');
    expect(container.querySelector<HTMLButtonElement>('[data-import-run]')?.disabled).toBe(true);
    expect(calls.some(call => call.route === 'POST /v1/runtimes/proposals')).toBe(false);
  });

  test('a refusal is said in the daemon’s words, nothing stays held, and the person can press again', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    let refuse = true;
    const { container } = await mount(
      'import-run',
      harness,
      machine(FULL, {
        [APPLY]: () => {
          if (!refuse) return { outcome: 'executed', executor: 'setup', summary: APPLIED_SENTENCES };
          return Object.assign(new Error('Codex is open in a terminal; close it and try again.'), {
            status: 409,
            code: 'busy',
          });
        },
      }),
    );
    await press(container, '[data-import-run]');
    expect(container.querySelector('[data-import-refusal]')?.textContent).toContain('close it and try again');
    expect(busyLabels(harness)).toEqual(['Importing…', null]);
    expect(harness.count('done')).toBe(0);
    refuse = false;
    await press(container, '[data-import-run]');
    expect(harness.count('done')).toBe(1);
  });

  test('nothing shown after a reload: nothing is left out, the page says what was not looked at, and it holds nobody', async () => {
    const harness = stepHarness({ segment: CHOOSE });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    expect(container.querySelector('[data-import-unreviewed]')?.textContent).toContain('Settings');
    expect(busyLabels(harness)).toEqual([]);
    await press(container, '[data-import-run]');
    expect(proposal(calls).skip ?? []).toEqual([]);
  });
});
