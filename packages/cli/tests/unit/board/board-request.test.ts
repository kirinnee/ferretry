import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildAssignAction,
  buildBlockAction,
  buildBoardCreateRequest,
  buildBoardQuery,
  buildClarifyAction,
  buildDependAction,
  buildDropAction,
  buildEditAction,
  buildFileAction,
  buildFocusAction,
  buildLinkAction,
  buildMoveAction,
  buildNoteAction,
  buildOrderAction,
  buildReparentAction,
  buildRefileAction,
  buildReopenAction,
  buildTriggerAction,
  buildUnblockAction,
  buildUndependAction,
  createPrLinks,
  DEFAULT_REOPEN_SOURCE,
  parseTerms,
  requireCardRef,
} from '../../../src/lib/board/board-request';
import { FERRETRY_ID } from './fixtures';

const PR_URL = 'https://github.com/kirinnee/ferretry/pull/42';
const resolved = { brief: '', projectId: undefined, assignee: null };
const minimal = { kind: 'feature', title: 'Rename widget', ask: 'rename it', askSource: 'chat://1' };

describe('requireCardRef', () => {
  it('should accept the &, the retired # and the bare spelling of one card', () => {
    // Act + Assert
    for (const raw of ['&F412', '#F412', 'F412', ' &f412 ']) {
      should(requireCardRef(raw)).eql({ id: 'F412' });
    }
  });

  it('should refuse junk and say which flag it was reading', () => {
    // Act + Assert
    for (const raw of ['', 'F', '412', 'X1', '&&F1', 'F1 F2']) {
      should(() => requireCardRef(raw)).throw(/expected a task id like &F21/u);
    }
    should(() => requireCardRef('nope', '--parent id')).throw(/expected a --parent id like &F21, got "nope"/u);
  });
});

describe('parseTerms', () => {
  it('should split on the first = and trim both sides', () => {
    // Act
    const terms = parseTerms(['lane = a column = of cards', 'card=one task']);

    // Assert
    should(terms).eql([
      { term: 'lane', meaning: 'a column = of cards' },
      { term: 'card', meaning: 'one task' },
    ]);
  });

  it('should refuse an entry with no term, no meaning or no =', () => {
    // Act + Assert
    for (const entry of ['nope', '=meaning', 'term=', 'term=   ']) {
      should(() => parseTerms([entry])).throw(/--term takes term=meaning, with the term first/u);
    }
  });

  it('should refuse a term listed twice, whatever its case', () => {
    // Act + Assert
    should(() => parseTerms(['Lane=a', 'lane=b'])).throw(/--term is not usable: value: each term appears once/u);
  });
});

describe('createPrLinks', () => {
  it('should return the trimmed PR urls and skip blanks', () => {
    // Act + Assert
    should(createPrLinks({ pr: [` ${PR_URL} `, '  '] })).eql([PR_URL]);
    should(createPrLinks({})).eql([]);
  });

  it('should refuse a value that is not a GitHub pull request URL', () => {
    // Act + Assert
    should(() => createPrLinks({ pr: ['https://example.com/x/y/pull/1'] })).throw(
      /--pr takes a GitHub pull request URL, got "https:\/\/example.com\/x\/y\/pull\/1"/u,
    );
    should(() => createPrLinks({ pr: [PR_URL, 'pull/42'] })).throw(/--pr takes a GitHub pull request URL/u);
  });
});

describe('buildBoardCreateRequest', () => {
  it('should build the whole request with every default the daemon would have filled', () => {
    // Act
    const request = buildBoardCreateRequest(minimal, [], resolved);

    // Assert
    should(request).eql({
      kind: 'feature',
      title: 'Rename widget',
      summary: '',
      ask: { text: 'rename it', source: 'chat://1' },
      premise: '',
      context: '',
      terms: [],
      brief: '',
      howToTest: '',
      workflow: 'quick',
      parent: null,
      assignee: null,
      dependsOn: [],
      files: [],
      docs: [],
    });
  });

  it('should take the title from the trailing words unless --title is given', () => {
    // Act + Assert
    should(buildBoardCreateRequest({ ...minimal, title: undefined }, ['Fix', 'the', 'thing'], resolved).title).equal(
      'Fix the thing',
    );
    should(buildBoardCreateRequest(minimal, ['ignored'], resolved).title).equal('Rename widget');
  });

  it('should carry every optional field through, trimmed', () => {
    // Arrange
    const projectId = FERRETRY_ID;

    // Act
    const request = buildBoardCreateRequest(
      {
        ...minimal,
        summary: ' one line ',
        premise: ' why ',
        context: ' where ',
        term: ['a=b'],
        workflow: 'design-first',
        parent: '&F9',
        branch: ' feat/x ',
        doc: [' docs/a.md ', ''],
        file: [' src/a.ts '],
        lane: ' implement ',
      },
      [],
      { brief: 'the plan', projectId, assignee: 'sess-1' },
    );

    // Assert
    should(request).containEql({
      summary: 'one line',
      premise: 'why',
      context: 'where',
      terms: [{ term: 'a', meaning: 'b' }],
      brief: 'the plan',
      workflow: 'design-first',
      projectId,
      laneId: 'implement',
      parent: { id: 'F9' },
      assignee: 'sess-1',
      files: ['src/a.ts'],
      branch: 'feat/x',
      docs: ['docs/a.md'],
    });
  });

  it('should carry How to test, and write a repeated --premise or --context as one bullet each', () => {
    // Act
    const request = buildBoardCreateRequest(
      { ...minimal, premise: [' cards are hard to read ', '', 'Done has no test steps'], context: [' agenda v6 '] },
      [],
      { ...resolved, howToTest: '1. Open the Board\n2. See the steps' },
    );

    // Assert
    should(request).containEql({
      premise: '- cards are hard to read\n- Done has no test steps',
      context: 'agenda v6',
      howToTest: '1. Open the Board\n2. See the steps',
    });
  });

  it('should accept --depends-on written as #F1, &F2 or F3', () => {
    // Act
    const request = buildBoardCreateRequest({ ...minimal, dependsOn: ['#F1', '&F2', 'F3'] }, [], resolved);

    // Assert
    should(request.dependsOn).eql([{ task: { id: 'F1' } }, { task: { id: 'F2' } }, { task: { id: 'F3' } }]);
  });

  it('should refuse a missing or unknown --kind', () => {
    // Act + Assert
    should(() => buildBoardCreateRequest({ ...minimal, kind: undefined }, [], resolved)).throw(
      /--kind is required \(bug, feature, infra, chore\)/u,
    );
    should(() => buildBoardCreateRequest({ ...minimal, kind: '  ' }, [], resolved)).throw(/--kind is required/u);
    should(() => buildBoardCreateRequest({ ...minimal, kind: 'epic' }, [], resolved)).throw(
      /--kind must be one of bug \| feature \| infra \| chore, got "epic"/u,
    );
  });

  it('should refuse a missing title and a title over five words', () => {
    // Act + Assert
    should(() => buildBoardCreateRequest({ ...minimal, title: undefined }, [], resolved)).throw(
      /--title is required \(or pass the title as the trailing words\)/u,
    );
    should(() => buildBoardCreateRequest({ ...minimal, title: 'one two three four five six' }, [], resolved)).throw(
      /task title has 6 words/u,
    );
  });

  it('should refuse a create with no --ask or no --ask-source', () => {
    // Act + Assert
    should(() => buildBoardCreateRequest({ ...minimal, ask: undefined }, [], resolved)).throw(
      /create requires --ask with the human words and --ask-source with the link they came from/u,
    );
    should(() => buildBoardCreateRequest({ ...minimal, askSource: ' ' }, [], resolved)).throw(/create requires --ask/u);
  });

  it('should refuse a workflow, a term, a parent or a dependency it cannot read', () => {
    // Act + Assert
    should(() => buildBoardCreateRequest({ ...minimal, workflow: 'slow' }, [], resolved)).throw(
      /--workflow must be one of/u,
    );
    should(() => buildBoardCreateRequest({ ...minimal, term: ['bad'] }, [], resolved)).throw(
      /--term takes term=meaning/u,
    );
    should(() => buildBoardCreateRequest({ ...minimal, parent: 'junk' }, [], resolved)).throw(
      /expected a --parent id like &F21, got "junk"/u,
    );
    should(() => buildBoardCreateRequest({ ...minimal, dependsOn: ['F1', 'junk'] }, [], resolved)).throw(
      /expected a --depends-on id like &F21, got "junk"/u,
    );
  });

  it('should hand a request the wire schema rejects back as a refusal that names the field', () => {
    // Act + Assert
    should(() => buildBoardCreateRequest({ ...minimal, summary: 'two\nlines' }, [], resolved)).throw(
      /cannot create this task: summary: one line/u,
    );
  });
});

describe('the action builders', () => {
  it('should build a move, dropping a blank reason', () => {
    // Act + Assert
    should(buildMoveAction('review', ' ship it ')).eql({ action: 'move', to: 'review', reason: 'ship it' });
    should(buildMoveAction('review', '  ')).eql({ action: 'move', to: 'review' });
    should(buildMoveAction('review', undefined)).eql({ action: 'move', to: 'review' });
    should(() => buildMoveAction('Not A Lane', undefined)).throw(/cannot move: to:/u);
  });

  it('should build a trigger from an external event only', () => {
    // Act + Assert
    should(buildTriggerAction(' deploy.done ')).eql({ action: 'trigger', event: 'deploy.done' });
    should(buildTriggerAction('deploy.done', ' prod is up ')).eql({
      action: 'trigger',
      event: 'deploy.done',
      reason: 'prod is up',
    });
    should(buildTriggerAction('pr.review_approved')).eql({ action: 'trigger', event: 'pr.review_approved' });
    should(() => buildTriggerAction('pr.merged')).throw(/not an event you can report.*deploy\.done/u);
    should(() => buildTriggerAction('')).throw(/not an event you can report/u);
  });

  it('should build a focus', () => {
    // Act + Assert
    should(buildFocusAction()).eql({ action: 'focus' });
  });

  it('should join the block words and refuse a block that says nothing', () => {
    // Act + Assert
    should(buildBlockAction(['waiting', 'on', 'vendor'])).eql({ action: 'block', reason: 'waiting on vendor' });
    should(() => buildBlockAction([])).throw(/cannot block \(say why\)/u);
  });

  it('should build an unblock with or without a reason', () => {
    // Act + Assert
    should(buildUnblockAction(' fixed ')).eql({ action: 'unblock', reason: 'fixed' });
    should(buildUnblockAction(undefined)).eql({ action: 'unblock' });
  });

  it('should build a depend that waits for a ship by default, and accept a release or an owner override', () => {
    // Act + Assert
    should(buildDependAction('#F2', {})).eql({ action: 'depend', task: { id: 'F2' }, until: 'shipped' });
    should(buildDependAction('F2', { until: 'released', override: ' urgent ' })).eql({
      action: 'depend',
      task: { id: 'F2' },
      until: 'released',
      override: { reason: 'urgent' },
    });
    should(() => buildDependAction('F2', { until: 'never' })).throw(/--until must be one of shipped \| released/u);
    should(() => buildDependAction('junk', {})).throw(/expected a dependency id like &F21/u);
  });

  it('should build an undepend with a default reason', () => {
    // Act + Assert
    should(buildUndependAction('&F2', undefined)).eql({
      action: 'undepend',
      task: { id: 'F2' },
      reason: 'no longer a dependency',
    });
    should(buildUndependAction('F2', 'moot')).containEql({ reason: 'moot' });
    should(() => buildUndependAction('junk', undefined)).throw(/expected a dependency id/u);
  });

  it('should require a reason to drop', () => {
    // Act + Assert
    should(buildDropAction(' superseded ')).eql({ action: 'drop', reason: 'superseded' });
    should(() => buildDropAction(undefined)).throw(/cannot drop \(--reason is required\)/u);
  });

  it('should build a reopen with the owner as the default source and a default reason', () => {
    // Act + Assert
    should(buildReopenAction({ to: 'plan', ask: 'actually, do more' })).eql({
      action: 'reopen',
      to: 'plan',
      reason: 'reopened with a new ask',
      ask: { text: 'actually, do more', source: DEFAULT_REOPEN_SOURCE },
    });
    should(buildReopenAction({ to: 'plan', ask: 'more', source: 'chat://2', reason: 'new scope' })).containEql({
      reason: 'new scope',
      ask: { text: 'more', source: 'chat://2' },
    });
    should(() => buildReopenAction({ ask: 'x' })).throw(/reopen needs --to <lane>/u);
    should(() => buildReopenAction({ to: 'plan' })).throw(/reopen needs --ask/u);
  });

  it('should build a clarify and require its source', () => {
    // Act + Assert
    should(buildClarifyAction(['also', 'dark', 'mode'], ' chat://3 ')).eql({
      action: 'clarify',
      text: 'also dark mode',
      source: 'chat://3',
    });
    should(() => buildClarifyAction(['x'], undefined)).throw(/clarify needs --source <link>/u);
    should(() => buildClarifyAction([], 'chat://3')).throw(/cannot clarify/u);
  });

  it('should build a link from exactly one of --pr, --branch, --commit, --doc', () => {
    // Act + Assert
    should(buildLinkAction({ pr: PR_URL })).eql({ action: 'link', pr: PR_URL });
    should(buildLinkAction({ branch: 'feat/x' })).eql({ action: 'link', branch: 'feat/x' });
    should(buildLinkAction({ commit: 'abc123' })).eql({ action: 'link', commit: 'abc123' });
    should(buildLinkAction({ doc: 'docs/a.md' })).eql({ action: 'link', doc: 'docs/a.md' });
    should(() => buildLinkAction({})).throw(/link takes exactly one of --pr, --branch, --commit or --doc/u);
    should(() => buildLinkAction({ pr: PR_URL, branch: 'x' })).throw(/exactly one of/u);
    should(() => buildLinkAction({ pr: 'not a url' })).throw(/--pr takes a GitHub pull request URL/u);
  });

  it('should build an assign to a session or to nobody', () => {
    // Act + Assert
    should(buildAssignAction('sess-1')).eql({ action: 'assign', assignee: 'sess-1' });
    should(buildAssignAction(null)).eql({ action: 'assign', assignee: null });
  });

  it('should join the note words and refuse an empty note', () => {
    // Act + Assert
    should(buildNoteAction(['hello', 'there'])).eql({ action: 'note', text: 'hello there' });
    should(() => buildNoteAction([])).throw(/cannot note \(say something\)/u);
  });

  it('should build an order from a rank, or clear it with --none', () => {
    // Act + Assert
    should(buildOrderAction('3', undefined)).eql({ action: 'order', order: 3 });
    should(buildOrderAction('0', false)).eql({ action: 'order', order: 0 });
    should(buildOrderAction(undefined, true)).eql({ action: 'order', order: null });
    should(() => buildOrderAction('3', true)).throw(/pass a rank or --none, not both/u);
    should(() => buildOrderAction(undefined, undefined)).throw(/order needs a rank, or --none/u);
    for (const bad of ['-1', '1.5', 'abc']) {
      should(() => buildOrderAction(bad, undefined)).throw(/the rank must be a whole number/u);
    }
  });

  it('should build a re-parent under a card, or to the top level with --none', () => {
    // Act + Assert
    should(buildReparentAction('&F85', undefined, undefined)).eql({ action: 'reparent', parent: { id: 'F85' } });
    should(buildReparentAction('f85', false, ' it fits ')).eql({
      action: 'reparent',
      parent: { id: 'F85' },
      reason: 'it fits',
    });
    should(buildReparentAction(undefined, true, undefined)).eql({ action: 'reparent', parent: null });
    should(() => buildReparentAction('F85', true, undefined)).throw(/pass --parent <id> or --none, not both/u);
    should(() => buildReparentAction(undefined, undefined, undefined)).throw(
      /reparent needs --parent <id>, or --none/u,
    );
    should(() => buildReparentAction('nonsense', undefined, undefined)).throw(/expected a task id like &F21/u);
  });

  it('should build a file claim, and a release with --remove', () => {
    // Act + Assert
    should(buildFileAction(' src/a.ts ', {})).eql({ action: 'file', path: 'src/a.ts' });
    should(buildFileAction('src/a.ts', { remove: true, reason: ' done ' })).eql({
      action: 'file',
      path: 'src/a.ts',
      release: true,
      reason: 'done',
    });
    should(buildFileAction('src/a.ts', { remove: false })).not.have.property('release');
    should(() => buildFileAction('  ', {})).throw(/cannot claim the file/u);
  });

  it('should build an edit from only the fields given, and replace the glossary whole', () => {
    // Act + Assert
    should(buildEditAction({ title: ' New name ' })).eql({ action: 'edit', title: 'New name' });
    should(
      buildEditAction({ summary: ' s ', premise: ' p ', context: ' c ', term: ['a=b'] }, { brief: 'the new brief' }),
    ).eql({
      action: 'edit',
      summary: 's',
      premise: 'p',
      context: 'c',
      terms: [{ term: 'a', meaning: 'b' }],
      brief: 'the new brief',
    });
    should(buildEditAction({ term: [] }, { brief: 'brief only' })).eql({ action: 'edit', brief: 'brief only' });
  });

  it('should edit How to test alone, and premise and context as bullets or cleared', () => {
    // Act + Assert
    should(buildEditAction({}, { howToTest: ' 1. Open it\n2. See it ' })).eql({
      action: 'edit',
      howToTest: '1. Open it\n2. See it',
    });
    should(buildEditAction({ premise: ['one', 'two'], context: [' only '] })).eql({
      action: 'edit',
      premise: '- one\n- two',
      context: 'only',
    });
    should(buildEditAction({ premise: [' '], context: [] })).eql({ action: 'edit', premise: '' });
  });

  it('should refuse an edit that changes nothing or retitles past five words', () => {
    // Act + Assert
    should(() => buildEditAction({})).throw(/nothing to edit: pass --title/u);
    should(() => buildEditAction({ term: [] })).throw(/nothing to edit/u);
    should(() => buildEditAction({ title: 'one two three four five six' })).throw(/task title has 6 words/u);
    should(() => buildEditAction({ title: '   ' })).throw(/cannot edit/u);
  });

  it('should build a refile with an optional lane and reason', () => {
    // Act + Assert
    should(buildRefileAction(FERRETRY_ID, {})).eql({ action: 'refile', projectId: FERRETRY_ID });
    should(buildRefileAction(FERRETRY_ID, { lane: ' todo ', reason: ' wrong board ' })).eql({
      action: 'refile',
      projectId: FERRETRY_ID,
      laneId: 'todo',
      reason: 'wrong board',
    });
    should(() => buildRefileAction('not-a-project', {})).throw(/cannot refile/u);
  });
});

describe('buildBoardQuery', () => {
  const everything = { projectId: undefined, ferretId: undefined };

  it('should build an empty query when no filter is given', () => {
    // Act + Assert
    should(buildBoardQuery({}, everything)).eql({});
  });

  it('should carry the resolved project and ferret and every filter', () => {
    // Act
    const query = buildBoardQuery(
      { kind: 'bug', pr: 'ci_red', activity: 'waiting_on_you', state: 'dropped', query: ' widget ' },
      { projectId: FERRETRY_ID, ferretId: 'sess-1' },
    );

    // Assert
    should(query).eql({
      project: FERRETRY_ID,
      ferret: 'sess-1',
      kind: 'bug',
      prState: 'ci_red',
      activity: 'waiting_on_you',
      state: 'dropped',
      query: 'widget',
    });
  });

  it('should read --closed as --state closed, and accept both when they agree', () => {
    // Act + Assert
    should(buildBoardQuery({ closed: true }, everything)).eql({ state: 'closed' });
    should(buildBoardQuery({ closed: true, state: 'closed' }, everything)).eql({ state: 'closed' });
    should(buildBoardQuery({ closed: false, state: 'all' }, everything)).eql({ state: 'all' });
  });

  it('should refuse --closed together with a different --state', () => {
    // Act + Assert
    should(() => buildBoardQuery({ closed: true, state: 'open' }, everything)).throw(
      /--closed means --state closed; pass one of them/u,
    );
  });

  it('should refuse a value outside any filter enum, naming the flag', () => {
    // Act + Assert
    should(() => buildBoardQuery({ state: 'gone' }, everything)).throw(/--state must be one of open \| closed/u);
    should(() => buildBoardQuery({ kind: 'epic' }, everything)).throw(/--kind must be one of/u);
    should(() => buildBoardQuery({ pr: 'purple' }, everything)).throw(/--pr must be one of none \| draft/u);
    should(() => buildBoardQuery({ activity: 'sleepy' }, everything)).throw(/--activity must be one of active/u);
  });

  it('should hand a query the wire schema rejects back as a refusal', () => {
    // Act + Assert
    should(() => buildBoardQuery({ query: 'x'.repeat(201) }, everything)).throw(
      /the board query is not usable: query:/u,
    );
  });
});
