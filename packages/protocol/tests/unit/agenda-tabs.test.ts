import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaActionRequestSchema,
  AgendaItemSchema,
  AgendaTabEditSchema,
  AgendaTabSchema,
  type AgendaTab,
  agendaTabNameProblem,
  agendaTabProblems,
  MAX_AGENDA_TAB_NAME_LENGTH,
  MAX_AGENDA_TABS,
  MAX_AGENDA_TABS_LENGTH,
} from '../../src/lib/agenda.ts';
import { agendaTabId, agendaTabs, applyAgendaTabEdits, findAgendaTab } from '../../src/lib/agenda-tabs.ts';

const AT = '2026-11-04T09:00:00.000Z';

const minimal = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approve the plan',
  why: 'Approve the plan',
  waitingSince: AT,
  howToResolve: 'Answer this item on the agenda board.',
  ask: { kind: 'open-question' },
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Olivier',
} as const;

const tab = (name: string, body = `${name} words`, id = name.toLowerCase()): AgendaTab => ({ id, name, body });

describe('the tabs, in order', () => {
  it('should draw the main tab first, then the full picture, then the ferret’s own, leaving the empty ones out', () => {
    const item = {
      questionAnswer: 'Yes, it pauses.',
      decided: '- SQLite',
      stillOpen: '- the export',
      whereWeAre: '## Status\nBuilding.',
      body: 'The report.',
      tabs: [tab('Status'), tab('Decisions')],
      ask: { kind: 'open-question' as const },
    };
    const tabs = agendaTabs(item);
    should(tabs.map(each => [each.kind, each.id, each.name])).deepEqual([
      ['main', 'main', 'Where we are now'],
      ['body', 'body', 'The full picture'],
      ['own', 'status', 'Status'],
      ['own', 'decisions', 'Decisions'],
    ]);
    should(tabs[0]).containDeep({
      questionAnswer: 'Yes, it pauses.',
      decided: '- SQLite',
      stillOpen: '- the export',
      whereWeAre: '## Status\nBuilding.',
    });
  });

  it('should leave the main tab out when it holds nothing, and call the body Reasoning on a review', () => {
    const tabs = agendaTabs({ body: 'Why.', whereWeAre: '  ', kind: 'review', ask: { kind: 'review' as never } });
    should(tabs.map(each => each.name)).deepEqual(['Reasoning']);
    should(agendaTabs({ ask: { kind: 'open-question' } })).deepEqual([]);
  });
});

describe('a tab’s id', () => {
  it('should be the name’s slug, unique, and never a fixed tab’s', () => {
    should(agendaTabId('Open risks!', new Set())).equal('open-risks');
    should(agendaTabId('Café ✓', new Set())).equal('cafe');
    should(agendaTabId('Risks', new Set(['risks', 'risks-2']))).equal('risks-3');
    should(agendaTabId('Main', new Set())).equal('main-2');
    should(agendaTabId('***', new Set())).equal('tab');
    should(agendaTabId('a'.repeat(40), new Set())).have.length(28);
  });
});

describe('a tab’s name and the set of tabs', () => {
  it('should say what is wrong with a name in plain words', () => {
    should(agendaTabNameProblem('Status')).be.undefined();
    should(agendaTabNameProblem(' Status')).containEql('starts or ends with a space');
    should(agendaTabNameProblem('')).equal('a tab needs a name');
    should(agendaTabNameProblem('x'.repeat(MAX_AGENDA_TAB_NAME_LENGTH + 1))).containEql('the most is 32');
    should(agendaTabNameProblem('a\nb')).containEql('one line');
    should(agendaTabNameProblem('a=b')).containEql('"="');
    should(agendaTabNameProblem('where we are now')).containEql('fixed tab');
  });

  it('should refuse too many tabs, a name or id twice, and tabs too long together', () => {
    const seven = Array.from({ length: MAX_AGENDA_TABS + 1 }, (_, index) => tab(`T${String(index)}`));
    should(agendaTabProblems(seven)[0]).containEql('at most 6 tabs');
    should(agendaTabProblems([tab('Risks'), tab('risks', 'x', 'other')])[0]).containEql('two tabs are called');
    should(agendaTabProblems([tab('A', 'x', 'same'), tab('B', 'y', 'same')])[0]).containEql('the id "same"');
    const half = 'x'.repeat(MAX_AGENDA_TABS_LENGTH / 2 + 1);
    should(agendaTabProblems([tab('A', half), tab('B', half)])[0]).containEql('the tabs together');
    should(agendaTabProblems([tab('A'), tab('B')])).deepEqual([]);
  });

  it('should parse a stored item’s tabs and refuse a bad one where it is read', () => {
    should(AgendaItemSchema.safeParse({ ...minimal, tabs: [tab('Status')] }).success).be.true();
    should(
      AgendaItemSchema.safeParse({ ...minimal, tabs: [tab('Status'), tab('status', 'x', 's2')] }).success,
    ).be.false();
    should(AgendaTabSchema.safeParse(tab('Where we are now', 'x', 'w')).success).be.false();
    should(AgendaTabSchema.safeParse(tab('Status', 'x', 'Bad Id')).success).be.false();
    // The fixed tabs' ids are never an own tab's (review of &F923).
    should(AgendaTabSchema.safeParse(tab('Status', 'x', 'main')).success).be.false();
    should(AgendaItemSchema.safeParse({ ...minimal, tabs: [tab('Notes', 'x', 'body')] }).success).be.false();
  });

  it('should take tab operations on an edit, each saying what to do, and remove alone', () => {
    const edit = (tabEdits: unknown) => AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', tabEdits });
    should(
      edit([
        { tab: 'Status', body: 'Now.' },
        { tab: 'Risks', remove: true },
      ]).success,
    ).be.true();
    should(AgendaTabEditSchema.safeParse({ tab: 'Risks', remove: true, body: 'x' }).success).be.false();
    should(AgendaTabEditSchema.safeParse({ tab: 'Risks' }).success).be.false();
    should(edit([]).success).be.false();
  });
});

describe('applying an edit’s tab operations', () => {
  const current = [tab('Status'), tab('Risks')];

  it('should make, rewrite, rename, move and remove, in order, as one list', () => {
    const result = applyAgendaTabEdits(current, [
      { tab: 'Decisions', body: 'We chose SQLite.' },
      { tab: 'status', body: 'Shipped.' },
      { tab: 'Risks', rename: 'Open risks' },
      { tab: 'decisions', position: 1 },
      { tab: 'Open risks', remove: true },
    ]);
    should(result).deepEqual({
      ok: true,
      tabs: [
        { id: 'decisions', name: 'Decisions', body: 'We chose SQLite.' },
        { id: 'status', name: 'Status', body: 'Shipped.' },
      ],
    });
  });

  it('should keep a renamed tab’s id, and move a tab past the end to the end', () => {
    const result = applyAgendaTabEdits(current, [{ tab: 'status', rename: 'Progress', position: 9 }]);
    should(result).deepEqual({
      ok: true,
      tabs: [tab('Risks'), { id: 'status', name: 'Progress', body: 'Status words' }],
    });
    should(applyAgendaTabEdits(undefined, [{ tab: 'Status', body: 'New.' }])).deepEqual({
      ok: true,
      tabs: [{ id: 'status', name: 'Status', body: 'New.' }],
    });
  });

  it('should never let a name be another tab’s id, so a name or an id always means one tab (review of &F923)', () => {
    // Status → Progress keeps the id "status": no other tab may then be called Status.
    const refused = applyAgendaTabEdits(
      [tab('Status'), tab('Risks')],
      [
        { tab: 'Status', rename: 'Progress' },
        { tab: 'Risks', rename: 'Status' },
      ],
    );
    should(refused).deepEqual({
      ok: false,
      problem: 'the name "Status" is the id of the tab "Progress": pick another name',
    });
    // A new tab never takes another tab's name as its id either.
    const made = applyAgendaTabEdits([tab('foo-bar', 'x', 'foo')], [{ tab: 'Foo Bar', body: 'y' }]);
    should(made.ok && made.tabs.map(each => each.id)).deepEqual(['foo', 'foo-bar-2']);
    // By name in any case, else by id.
    const kept = [tab('Progress', 'x', 'status'), tab('Risks')];
    should(findAgendaTab(kept, 'PROGRESS')).equal(0);
    should(findAgendaTab(kept, 'status')).equal(0);
    should(findAgendaTab(kept, 'nope')).equal(-1);
    // main and body are the fixed tabs' names on the command line: no own tab takes them.
    should(agendaTabNameProblem('Main')).containEql('fixed tab');
    should(agendaTabNameProblem('body')).containEql('fixed tab');
  });

  it('should refuse what cannot apply, in plain words', () => {
    const problem = (edits: Parameters<typeof applyAgendaTabEdits>[1]) => {
      const result = applyAgendaTabEdits(current, edits);
      return result.ok ? undefined : result.problem;
    };
    should(problem([{ tab: 'main', body: 'x' }])).containEql('--where-file');
    should(problem([{ tab: 'The full picture', body: 'x' }])).containEql('--body-file');
    should(problem([{ tab: 'Nope', remove: true }])).containEql('no tab "Nope" to remove');
    should(problem([{ tab: 'Nope', rename: 'Yes' }])).containEql('needs its words');
    should(problem([{ tab: 'a=b', body: 'x' }])).containEql('"="');
    should(problem([{ tab: 'Risks', rename: 'Reasoning' }])).containEql('fixed tab');
    should(problem([{ tab: 'Risks', rename: 'status' }])).containEql('two tabs are called');
  });
});
