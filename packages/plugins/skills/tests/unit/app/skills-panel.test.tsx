import { afterEach, describe, expect, it } from 'bun:test';
import { registerComposerQuoteTarget } from '@ferretry/app';
import { WithSlotPanels } from '@ferretry/app/testing';
import { isSkillsRowSlotProps, SKILLS_ROW_SLOT } from '../../../contract/index.ts';
import { createSkillsPanel } from '../../../app/views/skills-panel.tsx';
import { asView, click, closeAll, pageText, q, settle, show } from './dom-support.tsx';
import { ferretInventory, refusal, scripted, skill } from './skills-support.ts';

afterEach(closeAll);

const INVENTORY = 'GET /v1/ferrets/:ferretId/skills/inventory';
const FILE = 'GET /v1/skills/file';

const panelFor = (answers: Parameters<typeof scripted>[0]) => {
  const world = scripted(answers);
  const Panel = asView(createSkillsPanel(world.client));
  return { ...world, Panel };
};

const SKILLS = [
  skill('review', { scope: 'project', description: 'reviews a diff' }),
  skill('summary', { scope: 'user' }),
  skill('summary', { scope: 'ferretry', shadowedBy: 'user', path: '/fy/summary/SKILL.md' }),
];

describe('DOM tests: the Skills panel of a ferret', () => {
  it('offers the skills.add slot in its header once it knows the ferret and its daemon', async () => {
    const { Panel } = panelFor({ [INVENTORY]: ferretInventory([skill('review')]) });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-skills-active]') !== null, 'the header');
    expect(q('[data-context-list="skills"]')).not.toBeNull();
  });

  it('draws what this ferret can use, winners first, and says what it is', async () => {
    const { Panel, calls } = panelFor({ [INVENTORY]: ferretInventory(SKILLS) });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-list="skills"]') !== null, 'the skills list');
    expect([...document.querySelectorAll('[data-context-skill-use]')].map(node => node.textContent?.trim())).toEqual([
      '/review — put in the chat box',
      '/summary — put in the chat box',
      '/summary — put in the chat box',
    ]);
    expect(q('[data-context-skills-active]')?.textContent).toBe(
      '2 active in this ferret · Claude · inserts /name · account claude-default',
    );
    expect(pageText()).toContain('Not active: the skill of the same name in This account wins');
    expect(calls[0]?.init).toEqual({ params: { ferretId: 'f1' } });
  });

  it('uses the Codex spelling for a Codex ferret', async () => {
    const { Panel } = panelFor({ [INVENTORY]: ferretInventory([skill('review')], { harness: 'codex' }) });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-skill-use]') !== null, 'a skill row');
    expect(q('[data-context-skill-use]')?.textContent).toContain('$review');
  });

  it('puts the invocation in THIS ferret’s composer and nothing else', async () => {
    let draft = 'please';
    let other = 'untouched';
    const stop = [
      registerComposerQuoteTarget({
        daemonId: 'studio',
        ferretId: 'f1',
        draft: () => draft,
        replaceDraft: next => (draft = next),
      }),
      registerComposerQuoteTarget({
        daemonId: 'studio',
        ferretId: 'f2',
        draft: () => other,
        replaceDraft: next => (other = next),
      }),
      registerComposerQuoteTarget({
        daemonId: 'elsewhere',
        ferretId: 'f1',
        draft: () => other,
        replaceDraft: next => (other = next),
      }),
    ];
    try {
      const { Panel } = panelFor({ [INVENTORY]: ferretInventory([skill('review')]) });
      await show(<Panel subject="f1" />);
      await settle(() => q('[data-context-skill-use]') !== null, 'a skill row');
      await click(q('[data-context-skill-use]'), 'the skill name');
      expect(draft).toBe('please /review ');
      expect(other).toBe('untouched');
      expect(q('[data-context-skill-note]')?.textContent).toBe('Put /review in the chat box.');
    } finally {
      for (const release of stop) release();
    }
  });

  it('says so when no composer is open, rather than pretending it inserted', async () => {
    const { Panel } = panelFor({ [INVENTORY]: ferretInventory([skill('review')]) });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-skill-use]') !== null, 'a skill row');
    await click(q('[data-context-skill-use]'), 'the skill name');
    expect(q('[data-context-skill-note]')?.textContent).toBe('Open this ferret’s chat to use /review.');
  });

  it('narrows by the scope chips and by search', async () => {
    const { Panel } = panelFor({ [INVENTORY]: ferretInventory(SKILLS) });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-chips]') !== null, 'the chips');
    await click(q('[data-context-chip="project"]'), 'the Project chip');
    expect(document.querySelectorAll('[data-context-skill-scope]').length).toBe(1);
    expect(q('[data-context-skill-scope]')?.getAttribute('data-context-skill-scope')).toBe('project');
  });

  it('opens the SKILL.md of a listed skill by its listed path, front matter and document', async () => {
    const { Panel, calls } = panelFor({
      [INVENTORY]: ferretInventory([skill('review')]),
      [FILE]: (init: unknown) => ({
        path: (init as { query: { path: string } }).query.path,
        content: '---\nname: review\n---\n# Review it',
      }),
    });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-skill-open]') !== null, 'Open');
    await click(q('[data-context-skill-open]'), 'Open');
    await settle(() => q('[data-context-skill-front-matter]') !== null, 'the SKILL.md');
    expect(q('[data-context-skill-front-matter]')?.textContent).toBe('name: review');
    expect(pageText()).toContain('Review it');
    expect(calls.at(-1)?.init).toEqual({
      query: { path: '/home/me/.claude/skills/review/SKILL.md', ferretId: 'f1' },
    });
  });

  it('says a failed read in plain words and tries again on request', async () => {
    let answer: unknown = refusal(500, 'internal', 'could not reach the daemon');
    const { Panel } = panelFor({ [INVENTORY]: () => answer });
    await show(<Panel subject="f1" />);
    await settle(() => q('[data-context-failed]') !== null, 'the failure');
    expect(q('[data-context-failed]')?.textContent).toContain('This machine isn’t reachable right now');
    answer = ferretInventory([skill('review')]);
    await click(q('[data-context-retry]'), 'Try again');
    await settle(() => q('[data-context-list="skills"]') !== null, 'the list after retrying');
  });

  it('offers the skills.row slot on every skill’s row, with that skill’s own data', async () => {
    const { Panel } = panelFor({ [INVENTORY]: ferretInventory(SKILLS, { harness: 'codex' }) });
    const placed = {
      plugin: 'catalogs',
      id: 'skills-row',
      view: (props: Record<string, unknown>) => <i data-test-row={JSON.stringify(props)} />,
    };
    await show(
      <WithSlotPanels slots={{ [SKILLS_ROW_SLOT]: [placed] }}>
        <Panel subject="f1" />
      </WithSlotPanels>,
    );
    await settle(() => q('[data-test-row]') !== null, 'a row slot');
    const rows = [...document.querySelectorAll('[data-test-row]')].map(node =>
      JSON.parse(node.getAttribute('data-test-row') ?? ''),
    );
    expect(rows.map(row => [row.name, row.invocation, row.scope, row.ferret])).toEqual([
      ['review', '$review', 'project', 'f1'],
      ['summary', '$summary', 'user', 'f1'],
      ['summary', '$summary', 'ferretry', 'f1'],
    ]);
    expect(rows.every(row => isSkillsRowSlotProps(row))).toBe(true);
    expect(rows[2]?.path).toBe('/fy/summary/SKILL.md');
    // The copy's own runtimes ride along, so a contributing panel can tell which copy of a name the row is.
    expect(rows.map(row => row.runtimes)).toEqual([['claude-default'], ['claude-default'], ['claude-default']]);
    // The slot sits on the row's first line, beside Open, not under the description.
    expect(q('[data-context-skill-scope="project"] > div [data-test-row]')).not.toBeNull();
  });

  it('offers no row slot to a client the shell did not bind to a daemon', async () => {
    const world = scripted({ [INVENTORY]: ferretInventory([skill('review')]) });
    const Panel = asView(createSkillsPanel({ call: world.client.call }));
    const placed = { plugin: 'catalogs', id: 'skills-row', view: () => <i data-test-row="" /> };
    await show(
      <WithSlotPanels slots={{ [SKILLS_ROW_SLOT]: [placed] }}>
        <Panel subject="f1" />
      </WithSlotPanels>,
    );
    await settle(() => q('[data-context-list="skills"]') !== null, 'the skills list');
    expect(q('[data-test-row]')).toBeNull();
  });

  it('asks for a ferret when the shell names none', async () => {
    const { Panel, calls } = panelFor({});
    await show(<Panel />);
    expect(pageText()).toContain('Pick a ferret to see its skills.');
    expect(calls).toEqual([]);
  });
});
