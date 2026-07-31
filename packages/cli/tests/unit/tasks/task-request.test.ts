import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildAssignAction,
  buildClarifyAction,
  buildDependencyAction,
  buildFileAction,
  buildLinkAction,
  buildOrderAction,
  buildPhaseAction,
  buildReopenAction,
  buildStatusAction,
  buildTaskCreateRequest,
  buildTaskListFilters,
  buildTextAction,
  requireCount,
  resolveTaskListView,
} from '../../../src/lib/tasks/task-request';

const minimalCreate = {
  kind: 'feature',
  title: 'Rename the widget',
  ask: 'please rename it',
  askSource: 'chat://1',
};

describe('task create requests', () => {
  it('should build a complete request from the minimum a human must supply', () => {
    // Act
    const actual = buildTaskCreateRequest(minimalCreate, [], '');

    // Assert
    should(actual.kind).equal('feature');
    should(actual.title).equal('Rename the widget');
    should(actual.ask).eql({ text: 'please rename it', source: 'chat://1' });
    should(actual.workflow).equal('quick');
    should(actual.status).equal('todo');
    should(actual.assignee).be.null();
    should(actual.order).be.null();
    should(actual.dependsOn).eql([]);
  });

  it('should accept the title as trailing words when --title is absent', () => {
    // Act
    const actual = buildTaskCreateRequest({ ...minimalCreate, title: undefined }, ['Rename', 'the', 'widget'], '');

    // Assert
    should(actual.title).equal('Rename the widget');
  });

  it('should carry the brief it was handed', () => {
    // Act
    const actual = buildTaskCreateRequest(minimalCreate, [], 'the long form brief');

    // Assert
    should(actual.description).equal('the long form brief');
  });

  it('should canonicalize dependency ids and drop blank file claims', () => {
    // Act
    const actual = buildTaskCreateRequest(
      { ...minimalCreate, dependsOn: ['#f12', 'B3'], file: ['  src/a.ts ', '   ', 'src/b.ts'] },
      [],
      '',
    );

    // Assert
    should(actual.dependsOn).eql(['F12', 'B3']);
    should(actual.files).eql(['src/a.ts', 'src/b.ts']);
  });

  it('should collect every link kind', () => {
    // Act
    const actual = buildTaskCreateRequest(
      {
        ...minimalCreate,
        pr: ['https://example.test/pr/1', ''],
        commit: ['abc123'],
        doc: ['docs/design.md'],
        branch: 'port/widget',
      },
      [],
      '',
    );

    // Assert
    should(actual.links).eql({
      prs: ['https://example.test/pr/1'],
      commits: ['abc123'],
      docs: ['docs/design.md'],
      branch: 'port/widget',
    });
  });

  it('should refuse a missing or unknown kind', () => {
    // Act + Assert
    should(() => buildTaskCreateRequest({ ...minimalCreate, kind: undefined }, [], '')).throw(/--kind is required/u);
    should(() => buildTaskCreateRequest({ ...minimalCreate, kind: 'epic' }, [], '')).throw(/--kind must be one of/u);
  });

  it('should refuse an empty title and an over-long one', () => {
    // Act + Assert
    should(() => buildTaskCreateRequest({ ...minimalCreate, title: undefined }, [], '')).throw(/--title is required/u);
    should(() => buildTaskCreateRequest({ ...minimalCreate, title: 'one two three four five six' }, [], '')).throw(
      /has 6 words/u,
    );
  });

  it('should refuse a whitespace-only ask, which kteam accepted and stored as blank', () => {
    // Act + Assert
    should(() => buildTaskCreateRequest({ ...minimalCreate, ask: '   ' }, [], '')).throw(/create requires --ask/u);
    should(() => buildTaskCreateRequest({ ...minimalCreate, askSource: '' }, [], '')).throw(/--ask-source/u);
  });

  it('should refuse an unknown workflow or status', () => {
    // Act + Assert
    should(() => buildTaskCreateRequest({ ...minimalCreate, workflow: 'vibes' }, [], '')).throw(/--workflow must be/u);
    should(() => buildTaskCreateRequest({ ...minimalCreate, status: 'shipped' }, [], '')).throw(/--status must be/u);
  });

  it('should refuse creating blocked or dropped without a reason', () => {
    // Act + Assert
    should(() => buildTaskCreateRequest({ ...minimalCreate, status: 'blocked' }, [], '')).throw(
      /statusReason is required/u,
    );
    should(() => buildTaskCreateRequest({ ...minimalCreate, status: 'dropped' }, [], '')).throw(
      /statusReason is required/u,
    );
  });

  it('should accept blocked when the reason is supplied', () => {
    // Act
    const actual = buildTaskCreateRequest({ ...minimalCreate, status: 'blocked', reason: 'waiting on design' }, [], '');

    // Assert
    should(actual.status).equal('blocked');
    should(actual.statusReason).equal('waiting on design');
  });

  it('should refuse a status that is not part of the chosen workflow', () => {
    // Act + Assert — `investigate` never passes through build.
    should(() =>
      buildTaskCreateRequest({ ...minimalCreate, workflow: 'investigate', status: 'in_progress' }, [], ''),
    ).throw(/status is not part of the selected workflow/u);
  });

  it('should refuse an unparseable dependency id and a non-numeric order', () => {
    // Act + Assert
    should(() => buildTaskCreateRequest({ ...minimalCreate, dependsOn: ['nope'] }, [], '')).throw(/dependency id/u);
    should(() => buildTaskCreateRequest({ ...minimalCreate, order: 'first' }, [], '')).throw(/--order must be/u);
  });

  it('should keep repo and assignee when supplied and null them when blank', () => {
    // Act
    const supplied = buildTaskCreateRequest({ ...minimalCreate, repo: '/w/app', assignee: 'ada' }, [], '');
    const blank = buildTaskCreateRequest({ ...minimalCreate, repo: '  ', assignee: '' }, [], '');

    // Assert
    should(supplied.repo).equal('/w/app');
    should(supplied.assignee).equal('ada');
    should(blank.repo).be.null();
    should(blank.assignee).be.null();
  });
});

describe('task list filters', () => {
  it('should build no filters when nothing was asked for', () => {
    // Act
    const actual = buildTaskListFilters({});

    // Assert
    should(actual).eql([]);
  });

  it('should collect every filter, repeating status', () => {
    // Act
    const actual = buildTaskListFilters({
      repo: '/w/app',
      assignee: 'ada',
      kind: 'bug',
      status: ['todo', '', 'live'],
    });

    // Assert
    should(actual).eql([
      ['repo', '/w/app'],
      ['assignee', 'ada'],
      ['kind', 'bug'],
      ['status', 'todo'],
      ['status', 'live'],
    ]);
  });

  it('should refuse an unknown filter value rather than send it upstream', () => {
    // Act + Assert
    should(() => buildTaskListFilters({ kind: 'epic' })).throw(/--kind must be one of/u);
    should(() => buildTaskListFilters({ status: ['shipped'] })).throw(/--status must be one of/u);
  });

  it('should default to the plain board and accept the other two views', () => {
    // Act + Assert
    should(resolveTaskListView({})).equal('list');
    should(resolveTaskListView({ view: 'kanban' })).equal('kanban');
    should(resolveTaskListView({ view: 'dag' })).equal('dag');
    should(() => resolveTaskListView({ view: 'gantt' })).throw(/--view must be one of/u);
  });
});

describe('task actions', () => {
  it('should build a status move that records why', () => {
    // Act
    const actual = buildStatusAction('live', { reason: 'deployed', note: 'behind a flag' });

    // Assert
    should(actual).eql({ action: 'status', status: 'live', reason: 'deployed', note: 'behind a flag' });
  });

  it('should refuse a status move without a reason, locally, before a round trip', () => {
    // Act + Assert
    should(() => buildStatusAction('live', {})).throw(/requires --reason/u);
    should(() => buildStatusAction('live', { reason: '   ' })).throw(/requires --reason/u);
    should(() => buildStatusAction('shipped', { reason: 'x' })).throw(/status must be one of/u);
  });

  it('should build a phase move and refuse an unknown phase', () => {
    // Act + Assert
    should(buildPhaseAction('design', { reason: 'needs a spec' })).eql({
      action: 'phase',
      phase: 'design',
      reason: 'needs a spec',
    });
    should(() => buildPhaseAction('design', {})).throw(/requires --reason/u);
    should(() => buildPhaseAction('vibing', { reason: 'x' })).throw(/phase must be one of/u);
  });

  it('should require the new ask and its source when reopening', () => {
    // Act + Assert
    should(buildReopenAction({ reason: 'regressed', ask: 'it broke again', source: 'chat://9' })).eql({
      action: 'reopen',
      reason: 'regressed',
      ask: 'it broke again',
      source: 'chat://9',
    });
    should(() => buildReopenAction({ reason: 'regressed', ask: 'it broke again' })).throw(/reopen requires/u);
    should(() => buildReopenAction({ ask: 'x', source: 'y' })).throw(/reopen requires/u);
    should(() => buildReopenAction({ reason: 'x', source: 'y' })).throw(/reopen requires/u);
  });

  it('should join the clarification words verbatim', () => {
    // Act
    const actual = buildClarifyAction(['make', 'it', 'blue'], { source: 'chat://4' });

    // Assert
    should(actual).eql({ action: 'clarify', text: 'make it blue', source: 'chat://4' });
  });

  it('should refuse a clarification with no text or no source', () => {
    // Act + Assert
    should(() => buildClarifyAction([], { source: 'chat://4' })).throw(/clarify requires/u);
    should(() => buildClarifyAction(['hi'], {})).throw(/clarify requires/u);
  });

  it('should add and remove dependencies', () => {
    // Act + Assert
    should(buildDependencyAction('#f12', {})).eql({ action: 'dependency', taskId: 'F12', remove: false });
    should(buildDependencyAction('F12', { remove: true })).eql({ action: 'dependency', taskId: 'F12', remove: true });
    should(() => buildDependencyAction('nope', {})).throw(/dependency id/u);
  });

  it('should treat a file claim as advisory, so --reason stays optional', () => {
    // Act
    const actual = buildFileAction('src/widget.ts', {});

    // Assert
    should(actual).eql({ action: 'file', path: 'src/widget.ts', remove: false });
  });

  it('should carry the optional reason and the release flag on a file claim', () => {
    // Act
    const actual = buildFileAction('  src/widget.ts  ', { remove: true, reason: 'handed over' });

    // Assert
    should(actual).eql({ action: 'file', path: 'src/widget.ts', remove: true, reason: 'handed over' });
  });

  it('should refuse a blank file path', () => {
    // Act + Assert
    should(() => buildFileAction('   ', {})).throw(/file needs a path/u);
  });

  it('should record notes and feedback as their own history kinds', () => {
    // Act + Assert
    should(buildTextAction('note', ['looks', 'fine'])).eql({ action: 'note', text: 'looks fine' });
    should(buildTextAction('feedback', ['needs', 'tests'])).eql({ action: 'feedback', text: 'needs tests' });
    should(() => buildTextAction('note', ['  '])).throw(/note needs some text/u);
  });

  it('should attach exactly one link', () => {
    // Act + Assert
    should(buildLinkAction({ pr: 'https://example.test/pr/1' })).eql({
      action: 'link',
      field: 'pr',
      value: 'https://example.test/pr/1',
    });
    should(buildLinkAction({ doc: 'docs/x.md' })).eql({ action: 'link', field: 'doc', value: 'docs/x.md' });
  });

  it('should refuse zero links and more than one', () => {
    // Act + Assert
    should(() => buildLinkAction({})).throw(/exactly one of/u);
    should(() => buildLinkAction({ pr: 'a', doc: 'b' })).throw(/exactly one of/u);
    should(() => buildLinkAction({ branch: '   ' })).throw(/exactly one of/u);
  });

  it('should assign and unassign', () => {
    // Act + Assert
    should(buildAssignAction('ada', {})).eql({ action: 'assign', assignee: 'ada' });
    should(buildAssignAction(undefined, { none: true })).eql({ action: 'assign', assignee: null });
  });

  it('should refuse an ambiguous assignment instead of silently picking one', () => {
    // Act + Assert — kteam let --none win over a named teammate without saying so.
    should(() => buildAssignAction('ada', { none: true })).throw(/not both/u);
    should(() => buildAssignAction(undefined, {})).throw(/assign needs a teammate/u);
  });

  it('should rank and unrank', () => {
    // Act + Assert
    should(buildOrderAction('3', {})).eql({ action: 'order', order: 3 });
    should(buildOrderAction(undefined, { none: true })).eql({ action: 'order', order: null });
  });

  it('should refuse an ambiguous or non-numeric rank', () => {
    // Act + Assert
    should(() => buildOrderAction('3', { none: true })).throw(/not both/u);
    should(() => buildOrderAction(undefined, {})).throw(/order needs a rank/u);
    should(() => buildOrderAction('-1', {})).throw(/order must be a whole number/u);
    should(() => buildOrderAction('1.5', {})).throw(/order must be a whole number/u);
  });

  it('should accept zero as a rank', () => {
    // Act
    const actual = requireCount('0', '--after');

    // Assert
    should(actual).equal(0);
  });
});
