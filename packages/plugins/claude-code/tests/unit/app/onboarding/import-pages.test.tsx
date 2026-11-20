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
    expect(run.events).toEqual(['ready']);
    expect(proposals(calls)).toHaveLength(0);
    await click(view, '.cc-actions button');
    await settle();
    expect(proposals(calls).map(call => call.init?.body)).toEqual([
      { change: { kind: 'setup.import', include: ['claude-code'], names: { 'claude-code': 'claude-code-default' } } },
    ]);
    expect(run.events.slice(-3)).toEqual(['busy:Importing…', 'busy:null', 'done']);
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
    await click(view, '.cc-actions button');
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
    await click(run.view, '.cc-actions button');
    await settle();
    const [sent] = proposals(run.calls).map(call => call.init?.body as { change: { skip?: string[] } });
    expect(sent?.change.skip).toEqual(['claude-code:mcp:issues']);
  });

  it('the run never holds the footer before a write: busy is only for the request in flight', async () => {
    const { run } = await open(ImportRunPage, { importMode: 'choose' });
    expect(run.events).toEqual(['ready']);
    const lost = await open(ImportRunPage, {});
    expect(lost.run.events).toEqual(['ready']);
  });

  it('after a reload it asks again; picking a card (arrow keys included) sends nothing; only Import does', async () => {
    const { view, run, calls } = await open(ImportRunPage, {});
    expect(run.events[0]).toBe('ready');
    expect(view.container.querySelector('[data-import-lost]')).not.toBeNull();
    const button = must(view.container.querySelector<HTMLButtonElement>('.cc-actions button'), 'import');
    expect(button.disabled).toBe(true);
    await click(view, 'input[value="everything"]');
    expect(proposals(calls)).toHaveLength(0);
    expect(button.disabled).toBe(false);
    await click(view, '.cc-actions button');
    await settle();
    expect(proposals(calls)).toHaveLength(1);
    const [only] = proposals(calls).map(call => call.init?.body as { change: { skip?: unknown } });
    expect(only?.change.skip).toBeUndefined();
  });

  it('"Skip the import" records done and sends nothing', async () => {
    const { view, run, calls } = await open(ImportRunPage, { importMode: 'everything' });
    const buttons = view.container.querySelectorAll<HTMLButtonElement>('.cc-actions button');
    await interact(() => must(buttons[1], 'skip').click());
    expect(writes(calls)).toEqual([]);
    expect(run.events.slice(-2)).toEqual(['ready', 'done']);
  });

  it('a refused import shows the reason, frees the footer, and can be tried again', async () => {
    const routes = importRoutes(scanOf());
    routes['POST /v1/runtimes/proposals'] = new Error('This machine is busy.');
    const { view, run } = await open(ImportRunPage, { importMode: 'everything' }, routes);
    await click(view, '.cc-actions button');
    await settle();
    expect(view.container.querySelector('[data-import-refusal]')?.textContent).toContain('busy');
    expect(run.events.at(-1)).toBe('busy:null');
    expect(run.events).not.toContain('done');
  });

  it('writes nothing to localStorage or sessionStorage', async () => {
    const before = [localStorage.length, sessionStorage.length];
    const { view } = await open(ImportRunPage, { importMode: 'everything' });
    await click(view, '.cc-actions button');
    await settle();
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
  });
});
