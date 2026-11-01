import { describe, it } from 'bun:test';
import { type BoardTaskEvent, BoardTaskEventSchema } from '@ferretry/protocol';
import should from 'should';
import {
  activityLabel,
  type BoardVerb,
  describeEvent,
  laneName,
  prLabel,
  renderActed,
  renderBoard,
  renderBoardMarkdown,
  renderCard,
  renderTermsTable,
  type SessionNames,
  whoLabel,
} from '../../../src/lib/board/board-render';
import {
  ANON,
  AT,
  card,
  counts,
  DENISHA,
  FERRETRY_ID,
  KIRIN,
  laneSet,
  mergedPr,
  OTHER_ID,
  otherProject,
  pr,
  project,
  response,
} from './fixtures';

const NAMES: Readonly<Record<string, string>> = { [DENISHA]: 'denisha', [KIRIN]: 'kirin' };
const names: SessionNames = id => NAMES[id] ?? id;
const lanes = laneSet();

const ferret = (sessionId: string) => ({ kind: 'ferret' as const, sessionId });

/** An event checked against the wire schema, so a test can never describe an event the daemon would not send. */
const event = (fields: Record<string, unknown>): BoardTaskEvent =>
  BoardTaskEventSchema.parse({ seq: 2, at: AT, actor: ferret(DENISHA), ...fields });

const header = 'Ferretry — 3 cards · 0 closed hidden · 0 stale · 0 orphaned · 0 active · 0 to test · 0 waiting on you';

describe('prLabel', () => {
  it('should say there is no PR when none is linked', () => {
    // Act + Assert
    should(prLabel([])).equal('no PR');
  });

  it('should word each state of the newest PR the way the --pr filter does', () => {
    // Act + Assert
    should(prLabel([pr({ draft: true })])).equal('PR #42 draft');
    should(prLabel([pr()])).equal('PR #42 open');
    should(prLabel([pr({ checks: 'failing' })])).equal('PR #42 open, CI red');
    should(prLabel([mergedPr()])).equal('PR #42 merged');
    should(prLabel([pr({ state: 'closed' })])).equal('PR #42 closed');
    should(prLabel([pr({ state: 'unknown', polledAt: null })])).equal('PR #42 linked');
  });

  it('should name the release a merged PR shipped in', () => {
    // Arrange
    const released = mergedPr({ releasedIn: { version: '1.2.3', tag: 'v1.2.3', at: AT } });

    // Act + Assert
    should(prLabel([released])).equal('PR #42 released 1.2.3');
  });

  it('should show the last PR linked, not the first', () => {
    // Arrange
    const first = pr({ url: 'https://github.com/kirinnee/ferretry/pull/1', number: 1, state: 'closed' });
    const second = pr({ url: 'https://github.com/kirinnee/ferretry/pull/2', number: 2 });

    // Act + Assert
    should(prLabel([first, second])).equal('PR #2 open');
  });
});

describe('activityLabel', () => {
  const ask = [{ sessionId: DENISHA, id: 'A1' }];

  it('should show the derived activity when nothing outranks it', () => {
    // Act + Assert
    should(activityLabel(card({ activity: 'stale' }))).equal('stale');
  });

  it('should rank dropped over waiting on you over blocked over blocked by deps', () => {
    // Arrange
    const dropped = { reason: 'superseded', at: AT };
    const blocked = { on: 'external' as const, reason: 'vendor', since: AT };

    // Act + Assert
    should(
      activityLabel(card({ dropped, blocked, openAsks: ask, waitingOnOwner: ask, blockedBy: [{ id: 'F2' }] })),
    ).equal('dropped');
    should(activityLabel(card({ blocked, openAsks: ask, waitingOnOwner: ask, blockedBy: [{ id: 'F2' }] }))).equal(
      'waiting on you',
    );
    should(activityLabel(card({ blocked, blockedBy: [{ id: 'F2' }] }))).equal('blocked');
    should(activityLabel(card({ blockedBy: [{ id: 'F2' }], activity: 'active' }))).equal('blocked by deps');
  });
});

describe('whoLabel', () => {
  it('should show owner→assignee when somebody else has the card', () => {
    // Act + Assert
    should(whoLabel(card({ assignee: KIRIN }), names)).equal('denisha→kirin');
  });

  it('should show just the owner when unassigned or assigned to the owner', () => {
    // Act + Assert
    should(whoLabel(card(), names)).equal('denisha');
    should(whoLabel(card({ assignee: DENISHA }), names)).equal('denisha');
  });

  it('should fall back to the session id for a session the directory does not know', () => {
    // Act + Assert
    should(whoLabel(card({ owner: ANON, assignee: KIRIN }), names)).equal(`${ANON}→kirin`);
  });
});

describe('laneName', () => {
  it('should name a lane, and fall back to its id', () => {
    // Act + Assert
    should(laneName(lanes, 'review')).equal('Review/CI');
    should(laneName(lanes, 'gone')).equal('gone');
    should(laneName(null, 'review')).equal('review');
    should(laneName(undefined, 'review')).equal('review');
  });
});

describe('renderBoard', () => {
  const rows = [
    card({
      id: 'F3',
      title: 'Ship the release',
      laneId: 'review',
      links: { prs: [pr({ checks: 'failing' })], branch: null, commits: [], docs: [] },
    }),
    card({ id: 'F1', title: 'Rename the widget' }),
    card({ id: 'F2', title: 'Fix thing', laneId: 'implement', assignee: KIRIN, activity: 'active' }),
  ];

  it('should print the header, then each lane in Kanban order with its cards', () => {
    // Act
    const text = renderBoard(response({ cards: rows }), [project()], names, 'Ferretry');

    // Assert
    const title = (value: string) => value.padEnd('Rename the widget'.length);
    should(text.split('\n')).eql([
      header,
      '',
      'Todo (1)',
      `  &F1  ${title('Rename the widget')}  denisha  idle  no PR`,
      '',
      'Implement (1)',
      `  &F2  ${title('Fix thing')}  denisha→kirin  active  no PR`,
      '',
      'Review/CI (1)',
      `  &F3  ${title('Ship the release')}  denisha  idle  PR #42 open, CI red`,
    ]);
  });

  it('should print every id as &F…, never #F…', () => {
    // Act
    const text = renderBoard(response({ cards: rows }), [project()], names, 'Ferretry');

    // Assert
    should(text).not.match(/#F\d/u);
    should(text).match(/&F1\b/u).and.match(/&F2\b/u).and.match(/&F3\b/u);
  });

  it('should pad the id column to the widest id', () => {
    // Arrange
    const wide = [card({ id: 'F1' }), card({ id: 'F1234', title: 'Other' })];

    // Act
    const lines = renderBoard(response({ cards: wide }), [project()], names, 'Ferretry').split('\n');

    // Assert
    should(lines.find(line => line.includes('&F1  '))).startWith('  &F1     ');
  });

  it('should order a lane by rank, unranked last, ties by id number', () => {
    // Arrange
    const cards = [
      card({ id: 'F10', title: 'Ten' }),
      card({ id: 'F9', title: 'Nine' }),
      card({ id: 'F20', title: 'Ranked two', order: 2 }),
      card({ id: 'F30', title: 'Ranked one', order: 1 }),
    ];

    // Act
    const text = renderBoard(response({ cards }), [project()], names, 'Ferretry');

    // Assert
    const ids = text
      .split('\n')
      .filter(line => line.startsWith('  &'))
      .map(line => line.trim().split(' ')[0]);
    should(ids).eql(['&F30', '&F20', '&F9', '&F10']);
  });

  it('should append a lane the lane set no longer has, under its id', () => {
    // Arrange
    const cards = [card({ id: 'F1', laneId: 'archived' }), card({ id: 'F2', laneId: 'review' })];

    // Act
    const text = renderBoard(response({ cards }), [project()], names, 'Ferretry');

    // Assert
    const headings = text.split('\n').filter(line => /^\S.*\(\d+\)$/u.test(line));
    should(headings).eql(['Review/CI (1)', 'archived (1)']);
  });

  it('should clip a long title with an ellipsis', () => {
    // Arrange
    const long = 'Extraordinarily Reconfigurable Infrastructural Orchestration Middleware';

    // Act
    const text = renderBoard(response({ cards: [card({ title: long })] }), [project()], names, 'Ferretry');

    // Assert
    should(text)
      .containEql(`${long.slice(0, 47)}…`)
      .and.not.containEql(long);
  });

  it('should say so when no card matches', () => {
    // Act
    const text = renderBoard(response(), [project()], names, 'Ferretry');

    // Assert
    should(text).equal(
      'Ferretry — 0 cards · 0 closed hidden · 0 stale · 0 orphaned · 0 active · 0 to test · 0 waiting on you\n\nno cards match',
    );
  });

  it('should show the counts the daemon sent', () => {
    // Act
    const text = renderBoard(
      response({ counts: counts({ closedHidden: 7, stale: 1, orphaned: 2, active: 3, toTest: 4, waitingOnYou: 5 }) }),
      [project()],
      names,
      'Ferretry',
    );

    // Assert
    should(text.split('\n')[0]).equal(
      'Ferretry — 0 cards · 7 closed hidden · 1 stale · 2 orphaned · 3 active · 4 to test · 5 waiting on you',
    );
  });

  it('should note that more cards exist than the page holds', () => {
    // Act
    const text = renderBoard(response({ nextCursor: 'abc' }), [project()], names, 'Ferretry');

    // Assert
    should(text).containEql('more cards exist than this page holds');
  });

  it('should list a card the daemon could not read, with why', () => {
    // Act
    const text = renderBoard(
      response({ quarantined: [{ id: 'F9', reason: 'bad history' }] }),
      [project()],
      names,
      'Ferretry',
    );

    // Assert
    should(text.split('\n').at(-1)).equal('! F9 could not be read (bad history)');
  });

  it('should group a board across projects by project, each in its own lane order', () => {
    // Arrange
    const cards = [
      card({ id: 'F1', title: 'Mine' }),
      card({ id: 'F2', title: 'Theirs', projectId: OTHER_ID as never, laneId: 'investigate' }),
      card({ id: 'F3', title: 'Lost', projectId: 'unfiled', laneId: 'todo' }),
    ];
    const board = response({ projectId: null, laneSet: null, cards });

    // Act
    const text = renderBoard(board, [project(), otherProject()], names, 'all projects');

    // Assert
    const lines = text.split('\n');
    should(lines[0]).startWith('all projects — 3 cards');
    should(lines.filter(line => line.startsWith('# '))).eql(['# Ferretry', '# Other', '# unfiled']);
    should(lines).containEql('Investigate (1)').and.containEql('Todo (1)');
    should(lines.indexOf('# Ferretry')).be.below(lines.indexOf('# Other'));
  });

  it('should use the lane set the response carries for its own project', () => {
    // Arrange
    const renamed = laneSet({
      lanes: lanes.lanes.map(lane => (lane.id === 'todo' ? { ...lane, name: 'Inbox' } : lane)),
    });

    // Act
    const text = renderBoard(response({ laneSet: renamed, cards: [card()] }), [project()], names, 'Ferretry');

    // Assert
    should(text).containEql('Inbox (1)');
  });

  it('should fall back to the label when the project is not in the listing', () => {
    // Act
    const text = renderBoard(response({ cards: [card()] }), [], names, 'this board');

    // Assert
    should(text.split('\n')[0]).startWith('this board — 1 cards');
    should(text).containEql('Todo (1)');
  });
});

describe('renderBoardMarkdown', () => {
  it('should print a heading per lane and a table of its cards', () => {
    // Arrange
    const cards = [
      card({ id: 'F1', title: 'Rename | widget', assignee: KIRIN }),
      card({
        id: 'F2',
        title: 'Fix',
        laneId: 'review',
        links: { prs: [mergedPr()], branch: null, commits: [], docs: [] },
      }),
    ];

    // Act
    const text = renderBoardMarkdown(response({ cards }), [project()], names, 'Ferretry');

    // Assert
    should(text.split('\n')).eql([
      '# Ferretry — 2 cards · 0 closed hidden · 0 stale · 0 orphaned · 0 active · 0 to test · 0 waiting on you',
      '',
      '## Todo (1)',
      '',
      '| Task | Title | Who | Activity | PR |',
      '| --- | --- | --- | --- | --- |',
      '| &F1 | Rename \\| widget | denisha→kirin | idle | no PR |',
      '',
      '## Review/CI (1)',
      '',
      '| Task | Title | Who | Activity | PR |',
      '| --- | --- | --- | --- | --- |',
      '| &F2 | Fix | denisha | idle | PR #42 merged |',
    ]);
  });

  it('should nest lanes under a project heading when the board spans projects', () => {
    // Arrange
    const cards = [card({ id: 'F1' }), card({ id: 'F2', projectId: OTHER_ID as never, laneId: 'fix' })];
    const board = response({ projectId: null, laneSet: null, cards });

    // Act
    const text = renderBoardMarkdown(board, [project(), otherProject()], names, 'all projects');

    // Assert
    const lines = text.split('\n');
    should(lines[0]).startWith('# all projects — 2 cards');
    should(lines).containEql('## Ferretry').and.containEql('### Todo (1)');
    should(lines).containEql('## Other').and.containEql('### Fix (1)');
  });

  it('should say so when no card matches', () => {
    // Act
    const text = renderBoardMarkdown(response(), [project()], names, 'Ferretry');

    // Assert
    should(text.split('\n').slice(-2)).eql(['', 'No cards match.']);
  });
});

describe('describeEvent', () => {
  it('should word an event with the lane set’s names', () => {
    // Act + Assert
    should(
      describeEvent(event({ type: 'moved', from: 'todo', to: 'plan', backward: false, reason: 'go' }), lanes, names),
    ).equal('moved Todo → Plan/Design: go');
    should(describeEvent(event({ type: 'assigned', from: null, to: KIRIN }), lanes, names)).equal(
      'assigned nobody → kirin',
    );
  });

  it('should name lanes by id when the project has no lane set', () => {
    // Act + Assert
    should(describeEvent(event({ type: 'created', laneId: 'todo', seq: 1 }), null, names)).equal('created in todo');
  });
});

describe('renderTermsTable', () => {
  it('should align the meanings after the longest term', () => {
    // Act + Assert
    should(
      renderTermsTable([
        { term: 'lane', meaning: 'a column' },
        { term: 'card', meaning: 'one task' },
        { term: 'ubiquitous', meaning: 'shared words' },
      ]),
    ).equal('lane        a column\ncard        one task\nubiquitous  shared words');
  });
});

describe('renderCard', () => {
  const full = (): ReturnType<typeof card> =>
    card({
      id: 'F7',
      title: 'Rename the widget',
      laneId: 'implement',
      workflow: 'design-first',
      summary: 'make the widget name clearer',
      parent: { id: 'F5' },
      assignee: KIRIN,
      shippedIn: { version: '1.2.3', tag: 'v1.2.3', at: AT },
      suggestedLane: 'review',
      blocked: { on: 'external', reason: 'waiting on vendor', since: AT },
      ask: { text: 'rename it please', source: 'chat://1' },
      clarifications: [{ text: 'and the docs too', source: 'chat://2', at: AT, by: { kind: 'owner' } }],
      premise: 'the name confuses people',
      context: 'see &F3',
      terms: [
        { term: 'widget', meaning: 'the thing' },
        { term: 'lane', meaning: 'a column' },
      ],
      brief: 'rename it everywhere',
      howToTest: '1. Run fy task show\n2. See the new name',
      rollup: {
        children: 2,
        byCategory: { backlog: 1, active: 1, review: 0, shipped: 0, verify: 0, closed: 0 },
        active: 1,
        lastTouchedAt: null,
      },
      dependsOn: [
        { task: { id: 'F2' }, until: 'shipped' },
        { task: { id: 'F3' }, until: 'released' },
        { task: { id: 'F4' }, until: 'shipped', override: { by: 'owner', reason: 'urgent', at: AT } },
      ],
      blockedBy: [{ id: 'F2' }],
      blocks: [{ id: 'F8' }, { id: 'F9' }],
      links: {
        prs: [pr()],
        branch: 'feat/rename',
        commits: ['abc123'],
        docs: ['docs/a.md'],
      },
      files: ['src/a.ts', 'src/b.ts'],
      openAsks: [
        { sessionId: DENISHA, id: 'A1' },
        { sessionId: DENISHA, id: 'A2' },
      ],
      waitingOnOwner: [{ sessionId: DENISHA, id: 'A2' }],
      history: [
        event({ seq: 1, type: 'created', laneId: 'todo' }),
        event({ seq: 2, type: 'moved', from: 'todo', to: 'implement', backward: false, reason: null }),
        event({ seq: 3, type: 'note', text: 'started', actor: { kind: 'owner' } }),
        event({ seq: 4, type: 'note', text: 'from chat', actor: { kind: 'owner', sessionId: KIRIN } }),
        event({ seq: 5, type: 'blocked', reason: 'vendor', actor: { kind: 'daemon' } }),
        event({ seq: 6, type: 'note', text: 'checked', actor: { kind: 'owner' }, actorVia: 'admin-token' }),
      ],
    });

  const child = (id: string, laneId: string) =>
    card({ id, title: `Child ${id}`, laneId, parent: { id: 'F7' }, activity: 'active' });

  it('should print the face, the ask, then every section the card has', () => {
    // Act
    const text = renderCard(full(), lanes, [child('F11', 'implement'), child('F12', 'todo')], names);

    // Assert
    const lines = text.split('\n');
    should(lines.slice(0, 9)).eql([
      '&F7  Rename the widget  [feature]',
      'lane      Implement  ·  waiting on you  ·  workflow design-first',
      'who       denisha→kirin',
      `project   ${FERRETRY_ID}`,
      'summary   make the widget name clearer',
      'parent    &F5',
      'shipped   1.2.3',
      'suggests  Review/CI',
      'blocked   waiting on vendor',
    ]);
    should(lines).containEql('Ask').and.containEql('  rename it please').and.containEql('  — chat://1');
    should(lines).containEql('Clarified').and.containEql('  and the docs too').and.containEql('  — chat://2');
    should(lines).containEql('Premise').and.containEql('  the name confuses people');
    should(lines).containEql('Context').and.containEql('  see &F3');
    should(lines).containEql('Terms').and.containEql('  widget  the thing').and.containEql('  lane    a column');
    should(lines).containEql('Brief').and.containEql('  rename it everywhere');
    should(lines)
      .containEql('How to test')
      .and.containEql('  1. Run fy task show')
      .and.containEql('  2. See the new name');
  });

  it('should list the children with their lane and activity under a roll-up heading', () => {
    // Act
    const lines = renderCard(full(), lanes, [child('F11', 'implement'), child('F12', 'todo')], names).split('\n');

    // Assert
    should(lines).containEql('Children — 2 children, 1 active');
    should(lines).containEql('  &F11  Child F11  (Implement, active)');
    should(lines).containEql('  &F12  Child F12  (Todo, active)');
  });

  it('should say children are not on this board when the roll-up counts some that were not fetched', () => {
    // Act
    const lines = renderCard(full(), lanes, [], names).split('\n');

    // Assert
    should(lines).containEql('Children — 2 children, 1 active').and.containEql('  not on this board');
  });

  it('should show children even when the roll-up says none', () => {
    // Act
    const lines = renderCard(card(), lanes, [child('F11', 'todo')], names).split('\n');

    // Assert
    should(lines).containEql('Children — 0 children, 0 active');
  });

  it('should leave How to test out for a card without one', () => {
    // Act
    const text = renderCard(card(), lanes, [], names);

    // Assert
    should(text).not.match(/How to test/u);
  });

  it('should leave the children section out for a card with none', () => {
    // Act
    const text = renderCard(card(), lanes, [], names);

    // Assert
    should(text).not.match(/Children/u);
  });

  it('should mark each dependency waiting, done or overridden, and list what it blocks', () => {
    // Act
    const lines = renderCard(full(), lanes, [], names).split('\n');

    // Assert
    should(lines).containEql('Depends on');
    should(lines).containEql('  &F2  until shipped  (waiting)');
    should(lines).containEql('  &F3  until released  (done)');
    should(lines).containEql('  &F4  until shipped  (overridden)');
    should(lines).containEql('Blocks').and.containEql('  &F8, &F9');
  });

  it('should list the links, the files and the asks, saying which wait on the owner', () => {
    // Act
    const lines = renderCard(full(), lanes, [], names).split('\n');

    // Assert
    should(lines).containEql('Links');
    should(lines).containEql('  pr      https://github.com/kirinnee/ferretry/pull/42  (PR #42 open)');
    should(lines)
      .containEql('  branch  feat/rename')
      .and.containEql('  commit  abc123')
      .and.containEql('  doc     docs/a.md');
    should(lines).containEql('Files').and.containEql('  src/a.ts').and.containEql('  src/b.ts');
    should(lines).containEql('Asks').and.containEql('  open: !A1, !A2').and.containEql('  waiting on you: !A2');
  });

  it('should list open asks without a waiting line when none blocks', () => {
    // Act
    const lines = renderCard(card({ openAsks: [{ sessionId: DENISHA, id: 'A1' }] }), lanes, [], names).split('\n');

    // Assert
    should(lines).containEql('  open: !A1');
    should(lines.some(line => line.includes('waiting on you:'))).be.false();
  });

  it('should print the history with each actor named', () => {
    // Act
    const lines = renderCard(full(), lanes, [], names).split('\n');

    // Assert
    should(lines).containEql('History');
    should(lines).containEql(`    1  ${AT}  denisha  created in Todo`);
    should(lines).containEql(`    2  ${AT}  denisha  moved Todo → Implement`);
    should(lines).containEql(`    3  ${AT}  owner  note: started`);
    should(lines).containEql(`    4  ${AT}  owner via kirin  note: from chat`);
    should(lines).containEql(`    5  ${AT}  daemon  blocked: vendor`);
    // The admin token is said for what it is: never "owner".
    should(lines).containEql(
      `    6  ${AT}  the admin token (the owner at this machine, or a ferret without its own credential)  note: checked`,
    );
  });

  it('should print a dropped card as dropped, with why, and leave empty parts out', () => {
    // Arrange
    const dropped = card({ dropped: { reason: 'superseded', at: AT } });

    // Act
    const text = renderCard(dropped, lanes, [], names);

    // Assert
    const lines = text.split('\n');
    should(lines[1]).equal('lane      Todo  ·  dropped  ·  workflow quick');
    should(lines).containEql('dropped   superseded');
    for (const absent of [
      'summary',
      'parent',
      'shipped',
      'suggests',
      'blocked ',
      'Premise',
      'Context',
      'Terms',
      'Brief',
      'Links',
      'Files',
      'Asks',
      'Clarified',
      'Depends on',
      'Blocks',
    ]) {
      should(text).not.containEql(absent);
    }
  });

  it('should print every id as &F… and never as #F…', () => {
    // Act
    const text = renderCard(full(), lanes, [child('F11', 'todo')], names);

    // Assert
    should(text).not.match(/#F\d/u);
    should(text).match(/&F7\b/u);
  });

  it('should name lanes by id when the project has no lane set', () => {
    // Act
    const text = renderCard(card({ laneId: 'implement' }), null, [], names);

    // Assert
    should(text.split('\n')[1]).startWith('lane      implement');
  });
});

describe('renderActed', () => {
  const verbs: readonly (readonly [BoardVerb, string])[] = [
    ['create', 'created'],
    ['move', 'moved'],
    ['focus', 'is now your focus'],
    ['block', 'blocked'],
    ['unblock', 'unblocked'],
    ['depend', 'dependency recorded'],
    ['undepend', 'dependency removed'],
    ['drop', 'dropped'],
    ['reopen', 'reopened'],
    ['clarify', 'clarified'],
    ['link', 'linked'],
    ['assign', 'assigned'],
    ['note', 'noted'],
    ['order', 'ranked'],
    ['reparent', 're-parented'],
    ['file', 'file recorded'],
    ['edit', 'edited'],
    ['refile', 'refiled'],
  ];

  for (const [verb, past] of verbs) {
    it(`should say what ${verb} did and where the card stands now`, () => {
      // Act
      const line = renderActed(
        verb,
        card({ id: 'F1', laneId: 'review', assignee: KIRIN, activity: 'active' }),
        lanes,
        names,
      );

      // Assert
      should(line).equal(`&F1 ${past} — Review/CI, denisha→kirin, active`);
    });
  }

  it('should show the lane id when the lane set is unknown, and the waiting state', () => {
    // Arrange
    const ask = [{ sessionId: DENISHA, id: 'A1' }];

    // Act
    const line = renderActed('note', card({ openAsks: ask, waitingOnOwner: ask }), null, names);

    // Assert
    should(line).equal('&F1 noted — todo, denisha, waiting on you');
  });
});
