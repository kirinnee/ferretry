/**
 * The Claude import pages over a fake machine: each page's skip rule, what a tick does (memory only), the import's one
 * `setup.import`, the missing-memory ask after a reload, and that nothing is written on a selection or reaches storage.
 */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { importItemId } from '@ferretry/plugin-runtimes/contract';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { ImportRunPage, skipOf } from '../../../../app/features/onboarding/import/import-run-page.tsx';
import {
  InstructionsPage,
  McpPage,
  ModelSetPage,
  SettingsPage,
  SkillsPage,
} from '../../../../app/features/onboarding/import/kind-page.tsx';
import type { ClaudeCodeClient } from '../../../../app/lib/client.ts';
import type { StepPageProps } from '../../../../app/features/onboarding/props.ts';
import { itemStatus, selectedItems } from '../../../../app/features/onboarding/import/import-items.tsx';
import { allLeft } from '../../../../app/features/onboarding/import/segment.ts';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';
import { importRoutes, scanOf } from '../../../fixtures/onboarding/scan.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const PAGES = {
  settings: SettingsPage,
  'model-set': ModelSetPage,
  instructions: InstructionsPage,
  skills: SkillsPage,
  mcp: McpPage,
} as const;
type Kind = keyof typeof PAGES;

const open = async (
  Page: (props: StepPageProps<ClaudeCodeClient>) => ReactNode,
  segment: Record<string, string | boolean | number | undefined>,
  routes = importRoutes(scanOf()),
) => {
  const calls: Call[] = [];
  const run = stepHarness(segment);
  const view = await mount(<Page client={scripted(routes, calls)} step={run.step} />);
  mounted.push(view);
  await settle();
  return { view, run, calls };
};
const click = (view: Mounted, selector: string) =>
  interact(() => must(view.container.querySelector<HTMLElement>(selector), selector).click());

const KINDS = Object.keys(PAGES) as Kind[];
const writes = (calls: readonly Call[]): Call[] =>
  calls.filter(call => call.route.startsWith('POST') || call.route.startsWith('PUT'));

describe('each kind page decides for itself', () => {
  for (const kind of KINDS) {
    it(`${kind}: on "everything" and on "fresh" it is not needed for this run (never a skip, which is irreversible) and draws nothing; it shows on "choose"`, async () => {
      for (const importMode of ['everything', 'fresh']) {
        const { run, view } = await open(PAGES[kind], { importMode });
        expect(run.events).toEqual(['notNeeded']);
        expect(view.container.textContent).toBe('');
      }
      const { run, view } = await open(PAGES[kind], { importMode: 'choose' });
      expect(run.events).toEqual(['ready']);
      expect(view.container.querySelector(`[data-onboarding-step="claude-code.import-${kind}"]`)).not.toBeNull();
    });

    it(`${kind}: after a reload (no memory) it does not skip: it shows its checklist as in Customize, with no chooser and no extra button`, async () => {
      const { run, view } = await open(PAGES[kind], {});
      expect(run.events).toEqual(['ready']);
      expect(view.container.querySelector('[data-import-lost]')).toBeNull();
      expect(view.container.querySelector('[role="radiogroup"], [data-returned]')).toBeNull();
      expect(view.container.querySelector('[data-found-item] input:not(:checked)')).toBeNull();
    });
  }

  it('skips when the scan found nothing of its kind', async () => {
    const empty = scanOf({ instructions: false, settings: false, mcp: [], skills: [], secrets: [] });
    for (const kind of KINDS) {
      const { run } = await open(PAGES[kind], { importMode: 'choose' }, importRoutes(empty));
      expect(run.events).toEqual(['skip:not-needed']);
    }
  });

  it('the model set stays when its settings were left out, and says the models come from the settings', async () => {
    const left = JSON.stringify([importItemId('claude-code', 'settings')]);
    const { run, view } = await open(PAGES['model-set'], { importMode: 'choose', 'skip:settings': left });
    expect(run.events).toEqual(['ready']);
    expect(view.container.querySelector('[data-needs-settings]')).not.toBeNull();
    expect(view.container.querySelector('[data-found-item]')).toBeNull();
  });

  it('skips when Claude Code is not installed (the scan has nothing of it)', async () => {
    const { run } = await open(
      SettingsPage,
      { importMode: 'choose' },
      importRoutes(
        scanOf({ installed: false, instructions: false, settings: false, mcp: [], skills: [], secrets: [] }),
      ),
    );
    expect(run.events).toEqual(['skip:not-needed']);
  });
});

describe('the settings page', () => {
  it('shows hooks greyed as not imported, locked keys as kept in the Vault, and no hook is ever a row', async () => {
    const { view } = await open(SettingsPage, { importMode: 'choose' });
    const text = view.container.textContent ?? '';
    expect(text).toContain('Not imported');
    expect(text).toContain('Vault');
    expect(view.container.querySelector('[data-found-fixed="hooks"] input')).toBeNull();
  });

  it('a tick is memory of the run only: no call but the reads, and the left-out id is in the segment', async () => {
    const { view, run, calls } = await open(SettingsPage, { importMode: 'choose' });
    await click(view, `[data-found-item="${importItemId('claude-code', 'settings')}"] input`);
    expect(run.step.segment['skip:settings']).toBe(JSON.stringify([importItemId('claude-code', 'settings')]));
    expect(writes(calls)).toEqual([]);
    expect(run.events.filter(event => event === 'done')).toEqual([]);
  });
});

describe('the one-by-one pages build the skip list the r9 wizard builds', () => {
  it('leaving out an MCP server, a skill and the settings gives those ids plus the model set', async () => {
    const mcp = await open(McpPage, { importMode: 'choose' });
    await click(mcp.view, '[data-found-item="claude-code:mcp:issues"] input');
    const skills = await open(SkillsPage, { importMode: 'choose', ...mcp.run.step.segment });
    await click(skills.view, '[data-found-item="claude-code:skill:release-notes"] input');
    const settings = await open(SettingsPage, { importMode: 'choose', ...skills.run.step.segment });
    await click(settings.view, `[data-found-item="${importItemId('claude-code', 'settings')}"] input`);
    expect(skipOf(allLeft(settings.run.step.segment))).toEqual([
      'claude-code:settings',
      'claude-code:skill:release-notes',
      'claude-code:mcp:issues',
      'claude-code:model-set',
    ]);
  });
});

const proposals = (calls: readonly Call[]) => calls.filter(call => call.route === 'POST /v1/runtimes/proposals');

describe('the import run', () => {
  it('"everything" is the only import page: it sends one setup.import with nothing left out', async () => {
    const { view, run, calls } = await open(ImportRunPage, { importMode: 'everything' });
    // L270: the footer's Next is held while the page waits for its own Import.
    expect(run.events).toEqual(['ready', 'holdNext:true']);
    expect(proposals(calls)).toHaveLength(0);
    await click(view, '[data-import-run]');
    await settle();
    expect(proposals(calls).map(call => call.init?.body)).toEqual([
      { change: { kind: 'setup.import', include: ['claude-code'], names: { 'claude-code': 'claude-code-default' } } },
    ]);
    expect(run.events.slice(-4)).toEqual(['busy:Importing…', 'busy:null', 'done', 'holdNext:false']);
    expect(view.container.querySelector('[data-import-answer] ul')?.textContent).toContain('mcp/notes.yaml');
  });

  it('"choose" sends what the pages left out, the ticked tokens, and the typed name; hooks are never in it', async () => {
    const left = JSON.stringify(['claude-code:mcp:issues', 'claude-code:settings']);
    const { view, calls } = await open(ImportRunPage, {
      importMode: 'choose',
      'skip:mcp': JSON.stringify(['claude-code:mcp:issues']),
      'skip:settings': JSON.stringify(['claude-code:settings']),
      tickedEnv: JSON.stringify(['ANTHROPIC_API_KEY']),
    });
    expect(left).toContain('issues');
    expect(view.container.querySelector('[data-import-count]')?.textContent).toContain('leaving out 3');
    const name = must(view.container.querySelector<HTMLInputElement>('[data-runtime-name]'), 'name');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'work-claude');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(view, '[data-import-run]');
    await settle();
    const [sent] = proposals(calls).map(call => call.init?.body as { change: { skip: string[] } });
    expect(sent?.change).toMatchObject({
      kind: 'setup.import',
      include: ['claude-code'],
      names: { 'claude-code': 'work-claude' },
      skip: ['claude-code:settings', 'claude-code:mcp:issues', 'claude-code:model-set'],
      tickedEnv: ['ANTHROPIC_API_KEY'],
    });
    expect(JSON.stringify(sent)).not.toContain('hook');
  });

  it('"fresh" is not needed for this run (never a skip), draws nothing, and sends nothing', async () => {
    const { run, calls, view } = await open(ImportRunPage, { importMode: 'fresh' });
    expect(run.events).toEqual(['notNeeded']);
    expect(view.container.textContent).toBe('');
    expect(writes(calls)).toEqual([]);
  });

  it('Claude Code not installed: nothing to import, the page skips', async () => {
    const { run } = await open(
      ImportRunPage,
      { importMode: 'everything' },
      importRoutes(
        scanOf({ installed: false, instructions: false, settings: false, mcp: [], skills: [], secrets: [] }),
      ),
    );
    expect(run.events).toEqual(['skip:not-needed']);
  });

  it('after a reload the import is SELECTIVE: what the kind pages unticked since is in the proposal skip list', async () => {
    const mcp = await open(McpPage, {});
    await click(mcp.view, '[data-found-item="claude-code:mcp:issues"] input');
    const run = await open(ImportRunPage, mcp.run.step.segment);
    await click(run.view, 'input[value="everything"]');
    expect(run.view.container.querySelector('[data-import-count]')?.textContent).toContain('leaving out 1');
    await click(run.view, '[data-import-run]');
    await settle();
    const [sent] = proposals(run.calls).map(call => call.init?.body as { change: { skip?: string[] } });
    expect(sent?.change.skip).toEqual(['claude-code:mcp:issues']);
  });

  it('"Import everything": an item unticked on the final page stays unticked after Back and return, and is not sent', async () => {
    const first = await open(ImportRunPage, { importMode: 'everything' });
    const box = '[data-import-item="claude-code:mcp:issues"] input';
    await click(first.view, box);
    expect(must(first.view.container.querySelector<HTMLInputElement>(box), 'box').checked).toBe(false);
    // Back and return: the page mounts again over the memory the first visit left.
    const again = await open(ImportRunPage, first.run.step.segment);
    expect(must(again.view.container.querySelector<HTMLInputElement>(box), 'box').checked).toBe(false);
    expect(again.view.container.querySelector('[data-import-count]')?.textContent).toContain('leaving out 1');
    await click(again.view, '[data-import-run]');
    await settle();
    const [sent] = proposals(again.calls).map(call => call.init?.body as { change: { skip?: string[] } });
    expect(sent?.change.skip).toEqual(['claude-code:mcp:issues']);
  });

  it('the run never holds the footer before a write: busy is only for the request in flight', async () => {
    const { run } = await open(ImportRunPage, { importMode: 'choose' });
    expect(run.events).toEqual(['ready', 'holdNext:true']);
    const lost = await open(ImportRunPage, {});
    expect(lost.run.events).toEqual(['ready']);
  });

  it('after a reload it asks again; picking a card (arrow keys included) sends nothing; only Import does', async () => {
    const { view, run, calls } = await open(ImportRunPage, {});
    expect(run.events[0]).toBe('ready');
    expect(view.container.querySelector('[data-import-lost]')).not.toBeNull();
    const button = must(view.container.querySelector<HTMLButtonElement>('[data-import-run]'), 'import');
    expect(button.disabled).toBe(true);
    await click(view, 'input[value="everything"]');
    expect(proposals(calls)).toHaveLength(0);
    expect(button.disabled).toBe(false);
    await click(view, '[data-import-run]');
    await settle();
    expect(proposals(calls)).toHaveLength(1);
    const [only] = proposals(calls).map(call => call.init?.body as { change: { skip?: unknown } });
    expect(only?.change.skip).toBeUndefined();
  });

  it('the page has ONE action, Import: leaving is the footer’s Later / Next, so no second "skip" button; nothing is sent or recorded by arriving', async () => {
    const { view, run, calls } = await open(ImportRunPage, { importMode: 'everything' });
    expect(view.container.querySelector('[data-import-skip]')).toBeNull();
    expect(
      [...view.container.querySelectorAll('[data-import-actions] button')].map(button => button.textContent),
    ).toEqual(['↓Import']);
    expect(writes(calls)).toEqual([]);
    expect(run.events).not.toContain('done');
  });

  it('a refused import shows the reason, frees the footer, and can be tried again', async () => {
    const routes = importRoutes(scanOf());
    routes['POST /v1/runtimes/proposals'] = new Error('This machine is busy.');
    const { view, run } = await open(ImportRunPage, { importMode: 'everything' }, routes);
    await click(view, '[data-import-run]');
    await settle();
    expect(view.container.querySelector('[data-import-refusal]')?.textContent).toContain('busy');
    expect(run.events.at(-1)).toBe('busy:null');
    expect(run.events).not.toContain('done');
  });

  it('an import that stopped part-way lists what landed and what did not, beside the refusal', async () => {
    const routes = importRoutes(scanOf());
    routes['POST /v1/runtimes/proposals/:proposalId/apply'] = Object.assign(
      new Error('the disk is full. Part of this change was applied.'),
      {
        status: 409,
        code: 'fleet_change_failed',
        body: { landed: ['login claude-default'], notLanded: ['voice.yaml'] },
      },
    );
    const { view } = await open(ImportRunPage, { importMode: 'everything' }, routes);
    await click(view, '[data-import-run]');
    await settle();
    const note = must(view.container.querySelector('[data-import-partial]'), 'the partial note');
    expect(note.querySelector('[data-import-landed]')?.textContent).toContain('login claude-default');
    expect(note.querySelector('[data-import-not-landed]')?.textContent).toContain('voice.yaml');
  });

  it('after a failed import the press reads Try again, and it sends the import once more (C59 O5-10)', async () => {
    const routes = importRoutes(scanOf());
    const ok = routes['POST /v1/runtimes/proposals'];
    let first = true;
    routes['POST /v1/runtimes/proposals'] = (init: unknown) => {
      if (!first) return typeof ok === 'function' ? (ok as (init: unknown) => unknown)(init) : ok;
      first = false;
      return Object.assign(new Error('this machine asks you to confirm it is you with a passkey'), {
        status: 401,
        code: 'unlock_required',
      });
    };
    const { view, run, calls } = await open(ImportRunPage, { importMode: 'everything' }, routes);
    const press = () => must(view.container.querySelector<HTMLButtonElement>('[data-import-press]'), 'press');
    expect((press().textContent ?? '').replace('↓', '')).toBe('Import');
    await click(view, '[data-import-press]');
    await settle();
    expect(view.container.querySelector('[data-import-refusal]')?.textContent).toContain('locked');
    expect((press().textContent ?? '').replace('↓', '')).toBe('Try again');
    expect(press().disabled).toBe(false);
    await click(view, '[data-import-press]');
    await settle();
    expect(proposals(calls)).toHaveLength(2);
    expect(run.events.slice(-2)).toEqual(['done', 'holdNext:false']);
  });

  it('writes nothing to localStorage or sessionStorage', async () => {
    const before = [localStorage.length, sessionStorage.length];
    const { view } = await open(ImportRunPage, { importMode: 'everything' });
    await click(view, '[data-import-run]');
    await settle();
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
  });
});

describe('C59 O5 item 8: every item can be opened and chosen on the import page', () => {
  const rows = (view: Mounted): HTMLElement[] => [
    ...view.container.querySelectorAll<HTMLElement>('[data-import-item]'),
  ];
  const box = (view: Mounted, id: string): HTMLInputElement =>
    must(view.container.querySelector<HTMLInputElement>(`[data-import-item="${id}"] input[type="checkbox"]`), id);
  const sent = (calls: readonly Call[]) =>
    proposals(calls).map(call => call.init?.body as { change: { skip?: string[]; kind: string } });

  it('lists each item found with a tick (all ticked by default) and a fold that opens to what it becomes', async () => {
    const { view } = await open(ImportRunPage, { importMode: 'everything' });
    const found = rows(view);
    expect(found.map(row => row.getAttribute('data-import-item'))).toEqual(
      expect.arrayContaining([
        'claude-code:settings',
        'claude-code:model-set',
        'claude-code:instructions',
        'claude-code:mcp:notes',
        'claude-code:mcp:issues',
        'claude-code:skill:review',
        'claude-code:skill:release-notes',
      ]),
    );
    for (const row of found) {
      expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
      const fold = must(row.querySelector<HTMLDetailsElement>('details'), 'fold');
      expect(fold.open).toBe(false);
      expect(row.querySelector('summary')?.textContent?.length).toBeGreaterThan(0);
      expect(row.querySelector('[data-import-item-more]')?.textContent).toContain('Becomes:');
    }
    // The fold opens by its summary: a real <details>, so the keyboard and a screen reader get it free.
    const first = must(found[0]?.querySelector<HTMLElement>('summary'), 'summary');
    await interact(() => first.click());
    expect(found[0]?.querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
  });

  it('unticking an item here leaves it out of the request, and only the ticked ones are brought', async () => {
    const { view, calls, run } = await open(ImportRunPage, { importMode: 'everything' });
    expect(view.container.querySelector('[data-import-count]')?.textContent).toContain('Bringing 8 items');
    await interact(() => box(view, 'claude-code:mcp:issues').click());
    await interact(() => box(view, 'claude-code:skill:release-notes').click());
    expect(box(view, 'claude-code:mcp:issues').checked).toBe(false);
    expect(view.container.querySelector('[data-import-count]')?.textContent).toContain(
      'Bringing 6 items, leaving out 2',
    );
    // Told to the kind page it belongs to, so Back shows the same choice.
    expect(run.events.filter(event => event === 'remember').length).toBeGreaterThanOrEqual(2);
    await click(view, '[data-import-run]');
    await settle();
    expect(sent(calls)[0]?.change.skip).toEqual(['claude-code:mcp:issues', 'claude-code:skill:release-notes']);
    // An item the person unticked and ticked again is brought again.
  });

  it('ticking an unticked item again brings it again; with nothing changed the request carries no skip list', async () => {
    const { view, calls } = await open(ImportRunPage, { importMode: 'everything' });
    await interact(() => box(view, 'claude-code:mcp:issues').click());
    await interact(() => box(view, 'claude-code:mcp:issues').click());
    expect(box(view, 'claude-code:mcp:issues').checked).toBe(true);
    await click(view, '[data-import-run]');
    await settle();
    expect(sent(calls)[0]?.change.skip).toBeUndefined();
  });

  it('what the kind pages left out starts unticked here, and the model set follows a settings item that is left out', async () => {
    const { view, calls } = await open(ImportRunPage, {
      importMode: 'choose',
      'skip:mcp': JSON.stringify(['claude-code:mcp:issues']),
    });
    expect(box(view, 'claude-code:mcp:issues').checked).toBe(false);
    await interact(() => box(view, 'claude-code:settings').click());
    // Settings out: the models those settings name go with them, and say why.
    expect(box(view, 'claude-code:model-set').checked).toBe(false);
    expect(box(view, 'claude-code:model-set').disabled).toBe(true);
    expect(view.container.querySelector('[data-import-item="claude-code:model-set"]')?.textContent).toContain(
      'come from your settings',
    );
    await click(view, '[data-import-run]');
    await settle();
    expect(sent(calls)[0]?.change.skip).toEqual([
      'claude-code:mcp:issues',
      'claude-code:settings',
      'claude-code:model-set',
    ]);
  });

  it('selectedItems is the ids that are not on the skip list', () => {
    const a = importItemId('claude-code', 'settings');
    const b = importItemId('claude-code', 'instructions');
    expect(selectedItems([a, b], [b])).toEqual([a]);
    expect(selectedItems([a, b], [])).toEqual([a, b]);
    expect(selectedItems([a, b], [a, b])).toEqual([]);
  });
});

describe('C59 O5 item 9: the import shows it is working, with one status line per item', () => {
  it('draws one working bar and one line per item while the request is in flight, and says "Importing…" nowhere on the page', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const routes = importRoutes(scanOf());
    const apply = routes['POST /v1/runtimes/proposals/:proposalId/apply'];
    routes['POST /v1/runtimes/proposals/:proposalId/apply'] = async () => {
      await held;
      return apply;
    };
    const { view, run } = await open(ImportRunPage, { importMode: 'everything' }, routes);
    const bar = (): HTMLElement =>
      must(view.container.querySelector<HTMLElement>('[role="progressbar"]'), 'the working bar');
    expect(bar().getAttribute('data-working')).toBe('false');
    expect(bar().getAttribute('aria-busy')).toBe('false');
    await interact(() =>
      must(
        view.container.querySelector<HTMLInputElement>('[data-import-item="claude-code:mcp:issues"] input'),
        'box',
      ).click(),
    );
    await click(view, '[data-import-run]');
    await interact(async () => {
      for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(run.events.at(-1)).toBe('busy:Importing…');
    expect(view.container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(bar().getAttribute('data-working')).toBe('true');
    expect(bar().getAttribute('aria-busy')).toBe('true');
    const lines = [...view.container.querySelectorAll<HTMLElement>('[data-import-item]')].map(row => ({
      id: row.getAttribute('data-import-item'),
      status: row.querySelectorAll('[data-import-item-status]').length,
      text: row.querySelector('[data-import-item-status]')?.textContent,
    }));
    for (const line of lines) expect(line.status).toBe(1);
    expect(lines.find(line => line.id === 'claude-code:mcp:issues')?.text).toBe('Left out');
    expect(lines.filter(line => line.text === 'Bringing in…')).toHaveLength(lines.length - 1);
    // The footer's hold line is the one "Importing…"; the page itself never repeats it.
    expect(view.container.textContent).not.toContain('Importing…');
    // Nothing can be changed or pressed twice while it works.
    for (const input of view.container.querySelectorAll<HTMLInputElement>('[data-import-item] input'))
      expect(input.disabled).toBe(true);
    const importButton = must(view.container.querySelector<HTMLButtonElement>('[data-import-run]'), 'Import');
    expect(importButton.disabled).toBe(true);
    expect(importButton.getAttribute('aria-busy')).toBe('true');
    expect(importButton.querySelector('[data-spinner]')).not.toBeNull();

    release();
    await settle();
    expect(view.container.querySelector('[data-import-answer]')).not.toBeNull();
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('says nothing is happening to an item before the import starts: no status lines at rest', async () => {
    const { view } = await open(ImportRunPage, { importMode: 'everything' });
    for (const status of view.container.querySelectorAll<HTMLElement>('[data-import-item-status]'))
      expect(status.textContent).toBe('');
  });

  it('itemStatus: a ticked row is being brought and an unticked one is left out, only while it works', () => {
    expect(itemStatus(true, true)).toBe('bringing');
    expect(itemStatus(false, true)).toBe('left-out');
    expect(itemStatus(true, false)).toBeNull();
    expect(itemStatus(false, false)).toBeNull();
  });
});
