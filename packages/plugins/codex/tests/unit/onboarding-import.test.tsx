/// <reference lib="dom" />
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { type StepHarness, stepHarness } from '@ferretry/plugin-onboarding/contract/testing';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';
import { historyOf, withHistory } from '../../app/features/onboarding/import/history-config.ts';
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
    test(`${importMode}: it skips itself and reads nothing`, async () => {
      const harness = stepHarness({ segment: { importMode } });
      const { container, calls } = await mount('import-mcp', harness, machine(FULL));
      expect(harness.skippedWhy).toBe('not-needed');
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
  const FILE = (text: string, extra: object = {}) => ({
    'GET /v1/config/file': {
      path: 'harness-codex.yaml',
      text,
      etag: 'e1',
      exists: true,
      absolutePath: '/fake/home/config/harness-codex.yaml',
      ...extra,
    },
  });

  test('says the owner’s words, reads the value back from the file (no import mode needed), and writes nothing on opening', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('conversations', harness, machine(FULL, FILE('permissionMode: skip\n')));
    expect(container.querySelector('[data-conversations-words]')?.textContent).toBe(ONE_WAY_WORDS);
    expect(ONE_WAY_WORDS).toBe(
      'One way: Ferretry reads them and never changes them. A conversation is copied only when you continue it here.',
    );
    expect(container.querySelector<HTMLInputElement>('input[value="on"]')?.checked).toBe(true);
    expect(harness.decision).toBe('shown');
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
  });

  test('a file that says off opens on off', async () => {
    const harness = stepHarness();
    const { container } = await mount('conversations', harness, machine(FULL, FILE('hostHistory: false\n')));
    expect(container.querySelector<HTMLInputElement>('input[value="off"]')?.checked).toBe(true);
  });

  test('picking a card never writes: it holds Next and shows Save; Save writes only hostHistory, once, then answers', async () => {
    const harness = stepHarness();
    const text = '# my codex\npermissionMode: skip # keep\n';
    const { container, calls } = await mount('conversations', harness, machine(FULL, FILE(text)));
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="off"]')?.click();
    });
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
    expect(busyLabels(harness).at(-1)).toBe('Save your choice, or leave it as it is');
    expect(harness.count('done')).toBe(0);
    await press(container, '[data-conversations-save]');
    const writes = calls.filter(call => call.route === 'PUT /v1/config/file');
    expect(writes.length).toBe(1);
    const body = writes[0]?.options?.body as { path: string; text: string; etag: string };
    expect(body.path).toBe('harness-codex.yaml');
    expect(body.text).toContain('hostHistory: false');
    expect(body.text).toContain('# my codex');
    expect(body.text).toContain('permissionMode: skip # keep');
    expect(harness.count('done')).toBe(1);
    expect(busyLabels(harness).at(-1)).toBeNull();
  });

  test('picking the card it already is releases Next again (nothing to save)', async () => {
    const harness = stepHarness();
    const { container } = await mount('conversations', harness, machine(FULL, FILE('')));
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="off"]')?.click();
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="on"]')?.click();
    });
    expect(busyLabels(harness).at(-1)).toBeNull();
    expect(container.querySelector('[data-conversations-save]')).toBeNull();
  });

  test('a file the daemon withholds is never written: it says where to change it', async () => {
    const harness = stepHarness();
    const hidden =
      '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
    const { container, calls } = await mount('conversations', harness, machine(FULL, FILE(hidden)));
    expect(container.querySelector('[data-conversations-unknown]')?.textContent).toContain(
      'Change this at the machine: /fake/home/config/harness-codex.yaml',
    );
    expect(container.querySelector<HTMLInputElement>('input[value="off"]')?.disabled).toBe(true);
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
  });

  test('a change the daemon holds is said to be waiting, never shown as saved', async () => {
    const harness = stepHarness();
    const { container } = await mount(
      'conversations',
      harness,
      machine(FULL, { ...FILE('hostHistory: false\n'), 'PUT /v1/config/file': { outcome: 'pending' } }),
    );
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="on"]')?.click();
    });
    await press(container, '[data-conversations-save]');
    expect(container.querySelector('[data-conversations-note]')?.textContent).toContain(
      'waiting for your confirmation',
    );
    expect(harness.count('done')).toBe(0);
  });
});

describe('the hostHistory key', () => {
  test('is on unless the file says no, and a value that is not a yes or no is unknown', () => {
    expect(historyOf('')).toBe(true);
    expect(historyOf('permissionMode: skip\n')).toBe(true);
    expect(historyOf('hostHistory: false\n')).toBe(false);
    expect(historyOf("'hostHistory': false # comment\n")).toBe(false);
    expect(historyOf('{ hostHistory: true }\n')).toBe(true);
    expect(historyOf('hostHistory: maybe\n')).toBeNull();
    expect(historyOf('- a\n- b\n')).toBeNull();
  });

  test('a write changes only that key and keeps the comments', () => {
    expect(withHistory('# top\npermissionMode: skip\n', false)).toBe(
      '# top\npermissionMode: skip\nhostHistory: false\n',
    );
    expect(withHistory('hostHistory: true # why\nx: 1\n', false)).toContain('hostHistory: false # why');
    expect(() => withHistory('- a\n', false)).toThrow();
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

  test('everything: one page, nothing left out, the change names no hooks, and Next is held until it is brought over', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    expect(harness.decision).toBe('shown');
    expect(busyLabels(harness)).toEqual(['Bring it over to carry on']);
    expect(container.querySelector('[data-import-summary]')?.textContent).toContain('Everything your Codex holds');
    expect(calls.some(call => call.route === 'POST /v1/runtimes/proposals')).toBe(false);
    await press(container, '[data-import-run]');
    const change = proposal(calls);
    expect(change).toEqual({ kind: 'setup.import', include: ['codex'], names: { codex: 'codex-default' } });
    expect(JSON.stringify(change)).not.toMatch(/hook/iu);
    const apply = calls.find(call => call.route === APPLY);
    expect(apply).toBeDefined();
    expect(busyLabels(harness)).toEqual(['Bring it over to carry on', 'Importing…', null]);
    expect(harness.count('done')).toBe(1);
    expect(container.querySelector('[data-import-results]')?.textContent).toContain('mcp/notes.yaml');
    void CHANGE_ID;
  });

  test('choose: what the pages left out is the skip list; settings out takes the models they name; an unreviewed kind is left out and said', async () => {
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
    // The model-set kind was never reviewed (a reload since): its items are left out, and the page says so.
    expect(container.querySelector('[data-import-unreviewed]')?.textContent).toContain('Models');
    await press(container, '[data-import-run]');
    const change = proposal(calls);
    expect([...(change.skip ?? [])].sort()).toEqual(
      ['codex:settings', 'codex:model-set', 'codex:profile:fast', 'codex:profile:deep', 'codex:skill:deploy'].sort(),
    );
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

  test('starting fresh skips it and reads nothing', async () => {
    const harness = stepHarness({ segment: { importMode: 'fresh' } });
    const { calls } = await mount('import-run', harness, machine(FULL));
    expect(harness.skippedWhy).toBe('not-needed');
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
    expect(container.querySelector('[data-import-name]')).toBeNull();
    expect(container.querySelector('[data-import-existing]')?.textContent).toContain('codex-main');
    await press(container, '[data-import-run]');
    expect(proposal(calls).names).toBeUndefined();
  });

  test('an empty name is refused before anything is sent', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    const input = container.querySelector<HTMLInputElement>('[data-import-name]');
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

  test('a refusal is said in the daemon’s words, Next stays held, and the person can press again', async () => {
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
    expect(busyLabels(harness).at(-1)).toBe('Bring it over to carry on');
    expect(harness.count('done')).toBe(0);
    refuse = false;
    await press(container, '[data-import-run]');
    expect(harness.count('done')).toBe(1);
  });

  test('nothing reviewed after a reload: it imports nothing, says what was left out, and holds nobody', async () => {
    const harness = stepHarness({ segment: CHOOSE });
    const { container, calls } = await mount('import-run', harness, machine(FULL));
    expect(container.querySelector('[data-import-unreviewed]')?.textContent).toContain('Settings');
    expect(container.querySelector('[data-import-run]')).toBeNull();
    expect(busyLabels(harness)).toEqual([]);
    expect(calls.some(call => call.route === 'POST /v1/runtimes/proposals')).toBe(false);
  });
});
