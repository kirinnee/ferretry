import { describe, it } from 'bun:test';
import { BoardTaskSchema } from '@ferretry/protocol';
import should from 'should';
import { laneFromFacts } from '../../../src/lib/board/index.ts';
import {
  buildCard,
  type CardInput,
  isUntriagedCard,
  legacyRefOf,
  planSession,
  UNTRIAGED_TITLE,
  untriagedCard,
} from '../../../src/lib/board-import/index.ts';
import { card, lanes, MACHINE, NOW } from '../board/support.ts';
import { actorOf, daemonActor, entryOf, oldTask, statusAct, taskAt } from './support.ts';

const input = (overrides: Partial<CardInput> & Pick<CardInput, 'entry'>): CardInput => ({
  sessionId: 'lead',
  id: 'F10',
  machineId: MACHINE,
  laneSet: lanes(),
  plan: planSession([overrides.entry]),
  cardOf: new Map([[overrides.entry.task.id, 'F10']]),
  actorOf,
  assignee: null,
  askLinked: false,
  now: NOW,
  ...overrides,
});

const built = (overrides: Partial<CardInput> & Pick<CardInput, 'entry'>) => {
  const result = buildCard(input(overrides));
  if (!result.ok) throw new Error(result.detail);
  return result.card;
};

describe('legacyRefOf', () => {
  it('should join the session and the old id', () => {
    // Act
    const ref = legacyRefOf('lead', 'F12');

    // Assert
    should(ref).equal('lead:F12');
  });
});

describe('planSession', () => {
  const blocked = (id: string, reason: string | null, dependsOn: string[] = []) =>
    entryOf(oldTask({ id, status: 'blocked', statusReason: reason, dependsOn }));

  it('should read nothing for tasks that are not blocked', () => {
    // Act
    const plan = planSession([entryOf(oldTask())]);

    // Assert
    should([...plan.readings]).eql([]);
    should(plan.dependencies.get('F1')).eql([]);
  });

  it('should read an external and an owner block as they are', () => {
    // Act
    const plan = planSession([blocked('F1', 'CI down'), blocked('F2', 'needs approval'), blocked('F3', null)]);

    // Assert
    should(plan.readings.get('F1')).eql({ on: 'external' });
    should(plan.readings.get('F2')).eql({ on: 'owner' });
    should(plan.readings.get('F3')).eql({ on: 'external' });
  });

  it('should turn a block naming another task into a dependency', () => {
    // Act
    const plan = planSession([blocked('F1', 'waiting on F2'), entryOf(oldTask({ id: 'F2' }))]);

    // Assert
    should(plan.readings.get('F1')).eql({ on: 'tasks', ids: ['F2'] });
    should(plan.dependencies.get('F1')).eql(['F2']);
    should(plan.derived.get('F1')).eql(['F2']);
  });

  it('should not derive a dependency the task already has, and ignore self and unknown dependsOn', () => {
    // Act
    const plan = planSession([blocked('F1', 'waiting on F2', ['F2', 'F1', 'F9']), entryOf(oldTask({ id: 'F2' }))]);

    // Assert
    should(plan.readings.get('F1')).eql({ on: 'tasks', ids: ['F2'] });
    should(plan.dependencies.get('F1')).eql(['F2']);
    should(plan.derived.has('F1')).be.false();
  });

  it('should refuse a dependency that would close a cycle and fall back to external', () => {
    // Act
    const plan = planSession([blocked('F1', 'waiting on F2'), entryOf(oldTask({ id: 'F2', dependsOn: ['F1'] }))]);

    // Assert
    should(plan.readings.get('F1')).eql({ on: 'external' });
    should(plan.dependencies.get('F1')).eql([]);
  });

  it('should keep only the dependencies that do not close a cycle', () => {
    // Arrange
    const entries = [
      blocked('F1', 'waiting on F2 and F3'),
      entryOf(oldTask({ id: 'F2', dependsOn: ['F1'] })),
      entryOf(oldTask({ id: 'F3' })),
    ];

    // Act
    const plan = planSession(entries);

    // Assert
    should(plan.readings.get('F1')).eql({ on: 'tasks', ids: ['F3'] });
  });

  it('should walk a shared dependency once when looking for a cycle', () => {
    // Arrange
    const entries = [
      blocked('F1', 'waiting on F2'),
      entryOf(oldTask({ id: 'F2', dependsOn: ['F3', 'F4'] })),
      entryOf(oldTask({ id: 'F3', dependsOn: ['F5'] })),
      entryOf(oldTask({ id: 'F4', dependsOn: ['F5'] })),
      entryOf(oldTask({ id: 'F5' })),
    ];

    // Act
    const plan = planSession(entries);

    // Assert
    should(plan.readings.get('F1')).eql({ on: 'tasks', ids: ['F2'] });
  });
});

describe('buildCard', () => {
  it('should build a valid todo card with the migrated event last', () => {
    // Act
    const result = built({
      entry: entryOf(
        oldTask({ clarifications: [{ text: 'use bun', source: 'human', at: NOW, by: 'human', byName: null }] }),
      ),
    });

    // Assert
    should(BoardTaskSchema.safeParse(result).success).be.true();
    should(result).match({
      id: 'F10',
      machineId: MACHINE,
      laneId: 'todo',
      owner: 'lead',
      assignee: null,
      brief: 'details',
      legacyRef: 'lead:F1',
      createdBy: { kind: 'ferret', sessionId: 'lead' },
      clarifications: [{ text: 'use bun', by: { kind: 'owner' } }],
    });
    should(result.history.at(-1)).match({ type: 'migrated', legacyRef: 'lead:F1', seq: 2 });
  });

  for (const [status, expected] of [
    ['researched', 'plan'],
    ['in_progress', 'implement'],
    ['live', 'released'],
    ['done', 'closed'],
  ] as const) {
    it(`should file a ${status} task in ${expected}`, () => {
      // Act
      const result = built({ entry: entryOf(taskAt(status)) });

      // Assert
      should(result.laneId).equal(expected);
    });
  }

  it('should file a built task in review only when a pull request is linked', () => {
    // Act
    const withPr = built({
      entry: entryOf(
        taskAt('built', { links: { prs: ['https://github.com/a/b/pull/7'], branch: null, commits: [], docs: [] } }),
      ),
    });
    const without = built({ entry: entryOf(taskAt('built')) });

    // Assert
    should(withPr.laneId).equal('review');
    should(without.laneId).equal('implement');
  });

  it('should keep a blocked task in the lane its phase means', () => {
    // Act
    const result = built({ entry: entryOf(oldTask({ status: 'blocked', phase: 'build', statusReason: 'CI down' })) });

    // Assert
    should(result.laneId).equal('implement');
  });

  it('should carry an external block as a flag, since when it was blocked', () => {
    // Arrange
    const task = oldTask({ status: 'blocked', statusReason: 'CI down' });
    const entry = entryOf(task, [statusAct(2, 'todo', 'blocked', 'todo', { reason: 'CI down' })]);

    // Act
    const result = built({ entry });

    // Assert
    should(result.blocked).eql({ on: 'external', reason: 'CI down', since: '2026-10-02T10:00:00.000Z' });
  });

  it('should date a block without a blocked event by the last update, and word a missing reason', () => {
    // Act
    const result = built({ entry: entryOf(oldTask({ status: 'blocked', statusReason: null })) });

    // Assert
    should(result.blocked).eql({ on: 'external', reason: 'blocked', since: oldTask().updatedAt });
  });

  it('should leave an owner block to the agenda link when one carries it', () => {
    // Arrange
    const entry = entryOf(oldTask({ status: 'blocked', statusReason: 'needs approval' }));

    // Act
    const linked = built({ entry, askLinked: true });
    const flagged = built({ entry, askLinked: false });

    // Assert
    should(linked.blocked).be.null();
    should(linked.history.at(-2)).match({
      type: 'note',
      text: 'Blocked on the owner: needs approval — carried by the linked agenda ask.',
    });
    should(flagged.blocked).match({ on: 'external', reason: 'needs approval' });
    should(flagged.history.at(-2)).match({ type: 'note', text: 'Blocked: needs approval' });
  });

  it('should word an owner block that has no reason', () => {
    // Arrange
    const plan = planSession([entryOf(oldTask({ status: 'blocked', statusReason: 'needs approval' }))]);
    const entry = entryOf(oldTask({ status: 'blocked', statusReason: null }));

    // Act
    const result = built({ entry, plan: { ...plan, readings: new Map([['F1', { on: 'owner' as const }]]) } });

    // Assert
    should(result.history.at(-2)).match({ type: 'note', text: 'Blocked:' });
  });

  it('should turn a block naming a task into a dependency with a depended event', () => {
    // Arrange
    const entries = [
      entryOf(oldTask({ id: 'F1', status: 'blocked', statusReason: 'waiting on F2' })),
      entryOf(oldTask({ id: 'F2' })),
    ];
    const cardOf = new Map([
      ['F1', 'F10'],
      ['F2', 'F11'],
    ]);

    // Act
    const result = built({ entry: entries[0]!, plan: planSession(entries), cardOf });

    // Assert
    should(result.blocked).be.null();
    should(result.dependsOn).eql([{ task: { id: 'F11' }, until: 'shipped' }]);
    should(result.history.at(-2)).match({ type: 'depended', task: { id: 'F11' } });
  });

  it('should skip a dependency whose card was not imported, and one on itself', () => {
    // Arrange
    const entries = [
      entryOf(oldTask({ id: 'F1', status: 'blocked', statusReason: 'waiting on F2', dependsOn: ['F1', 'F3'] })),
      entryOf(oldTask({ id: 'F2' })),
      entryOf(oldTask({ id: 'F3' })),
    ];
    const cardOf = new Map([['F1', 'F10']]);

    // Act
    const result = built({ entry: entries[0]!, plan: planSession(entries), cardOf });

    // Assert
    should(result.dependsOn).eql([]);
    should(result.history.some(event => event.type === 'depended')).be.false();
  });

  it('should drop a dependency that names the card itself', () => {
    // Arrange
    const entries = [entryOf(oldTask({ id: 'F1', dependsOn: ['F2'] })), entryOf(oldTask({ id: 'F2' }))];
    const cardOf = new Map([
      ['F1', 'F10'],
      ['F2', 'F10'],
    ]);

    // Act
    const result = built({ entry: entries[0]!, plan: planSession(entries), cardOf });

    // Assert
    should(result.dependsOn).eql([]);
  });

  it('should own the card by the session and use a resolved assignee', () => {
    // Act
    const result = built({ entry: entryOf(oldTask({ assignee: 'Wilfredo' })), assignee: 'child' });

    // Assert
    should(result.assignee).equal('child');
    should(result.history.some(event => event.type === 'note')).be.false();
  });

  it('should fall back to the owner and keep the old assignee string in a note', () => {
    // Act
    const result = built({ entry: entryOf(oldTask({ assignee: 'Some Name' })), assignee: null });

    // Assert
    should(result.assignee).equal('lead');
    should(result.history.at(-2)).match({
      type: 'note',
      text: 'Old assignee "Some Name" is not a session; the card is owned by lead.',
    });
  });

  it('should record a drop with its reason and when it happened', () => {
    // Arrange
    const task = taskAt('dropped', { statusReason: 'not needed' });
    const entry = entryOf(task, [statusAct(2, 'todo', 'dropped', 'dropped', { reason: 'not needed' })]);

    // Act
    const result = built({ entry });

    // Assert
    should(result.dropped).eql({ reason: 'not needed', at: '2026-10-02T10:00:00.000Z' });
  });

  it('should word a drop with no reason and date it by the last update', () => {
    // Act
    const result = built({ entry: entryOf(taskAt('dropped', { statusReason: null })) });

    // Assert
    should(result.dropped).eql({ reason: 'dropped', at: oldTask().updatedAt });
  });

  it('should keep pull request URLs as PR links, once, and anything else linked as a doc', () => {
    // Arrange
    const url = 'https://github.com/a/b/pull/7';
    const task = oldTask({
      links: { prs: [url, url, 'not a pull request'], branch: 'feat/x', commits: ['c1', 'c1'], docs: ['d.md'] },
      files: ['a.ts', 'a.ts'],
    });

    // Act
    const result = built({ entry: entryOf(task) });

    // Assert
    should(result.links.prs).have.length(1);
    should(result.links.prs[0]).match({ url, number: 7, repo: 'a/b', state: 'unknown' });
    should(result.links).match({ branch: 'feat/x', commits: ['c1'], docs: ['d.md', 'not a pull request'] });
    should(result.files).eql(['a.ts']);
  });

  it('should leave an imported PR for the watcher: nothing is known about it, so the facts have no opinion yet', () => {
    // Arrange
    const task = oldTask({ links: { prs: ['https://github.com/a/b/pull/7'], branch: null, commits: [], docs: [] } });

    // Act
    const result = built({ entry: entryOf(task) });

    // Assert
    should(
      laneFromFacts(result, lanes(), result.workflow, { prs: result.links.prs, runningVersion: '9.0.0' }),
    ).be.null();
  });

  it('should refuse a task that will not parse as a card, naming the field', () => {
    // Act
    const result = buildCard(input({ entry: entryOf(oldTask({ title: 'one two three four five six' })) }));

    // Assert
    should(result.ok).be.false();
    should((result as { detail: string }).detail).startWith('title');
  });
});

describe('untriagedCard', () => {
  const make = () => untriagedCard({ sessionId: 'lead', id: 'C5', machineId: MACHINE, laneSet: lanes(), now: NOW });

  it('should be a valid chore in the first backlog lane made by the daemon', () => {
    // Act
    const result = make();

    // Assert
    should(BoardTaskSchema.safeParse(result).success).be.true();
    should(result).match({
      id: 'C5',
      kind: 'chore',
      title: UNTRIAGED_TITLE,
      laneId: 'todo',
      owner: 'lead',
      createdBy: daemonActor,
    });
    should(result.history).eql([{ seq: 1, at: NOW, actor: daemonActor, type: 'created', laneId: 'todo' }]);
  });

  it('should be recognised only for its own session, by title and maker', () => {
    // Arrange
    const untriaged = make();

    // Assert
    should(isUntriagedCard(untriaged, 'lead')).be.true();
    should(isUntriagedCard(untriaged, 'child')).be.false();
    should(isUntriagedCard({ ...untriaged, title: 'Other' }, 'lead')).be.false();
    should(isUntriagedCard(card({ title: UNTRIAGED_TITLE }), 'lead')).be.false();
  });
});
