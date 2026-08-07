import { describe, it } from 'bun:test';
import {
  ACTOR_AUTHORITY_SPLIT_SEMANTICS,
  MAX_TASK_CLARIFICATIONS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_FILES,
  MAX_TASK_LINKS_PER_FIELD,
  type TaskActionRequest,
  type TaskActivity,
  type TaskCreateRequestInput,
  type TaskId,
  type TaskLinks,
} from '@ferretry/protocol';
import should from 'should';
import { markLegacyAttestations } from '../../../src/lib/tasks/task-attestation.ts';
import { applyTaskAction, applyLink, createTask, requireTaskEntry } from '../../../src/lib/tasks/task-reducer.ts';
import type { TaskEntry, TaskSnapshot } from '../../../src/lib/tasks/task-snapshot.ts';
import { emptyTaskSnapshot } from '../../../src/lib/tasks/task-snapshot.ts';
import {
  LATER_INSTANT,
  MARK_DONE_GRANT,
  SESSION_ID,
  agent,
  context,
  human,
  shouldRefuse,
  snapshotOf,
  task,
  topAgent,
} from './fixtures.ts';

const id = (value: string): TaskId => value as TaskId;

const request = (overrides: Partial<TaskCreateRequestInput> = {}): TaskCreateRequestInput => ({
  kind: 'feature',
  title: 'Ship the board',
  ask: { text: 'ship it', source: 'human:cli' },
  ...overrides,
});

const lastActivity = (entry: TaskEntry): TaskActivity => entry.activity[entry.activity.length - 1] as TaskActivity;

const act = (snapshot: TaskSnapshot, id: string, action: TaskActionRequest, actor = agent()) =>
  applyTaskAction(snapshot, id, action, context(actor));

describe('createTask', () => {
  it('should place a first task on an empty board with its creation history', () => {
    // Act
    const outcome = createTask(emptyTaskSnapshot(), request(), context());

    // Assert
    should(outcome.entry.task.id).equal('F1');
    should(outcome.entry.task.phase).equal('todo');
    should(outcome.entry.task.status).equal('todo');
    should(outcome.entry.task.createdBy).equal('wilfredo');
    should(outcome.entry.task.createdAt).equal(LATER_INSTANT);
    should(outcome.snapshot.tasks).have.length(1);
    const created = lastActivity(outcome.entry);
    should(created.type).equal('created');
    should(created.seq).equal(1);
    should(created.data).have.property('askSource', 'human:cli');
  });

  it('should allocate the next identifier of the same kind against the whole board', () => {
    // Arrange
    const snapshot = snapshotOf(task({ id: id('F4') }), task({ id: id('B2'), kind: 'bug' }));

    // Act
    const outcome = createTask(snapshot, request(), context());

    // Assert
    should(outcome.entry.task.id).equal('F5');
    should(outcome.snapshot.tasks.map(entry => entry.task.id)).eql(['F4', 'B2', 'F5']);
  });

  it('should default the assignee to the owning session', () => {
    // Act
    const outcome = createTask(emptyTaskSnapshot(), request(), context());

    // Assert
    should(outcome.entry.task.assignee).equal(SESSION_ID);
  });

  it('should keep a task deliberately unassigned when the caller says so', () => {
    // Act
    const outcome = createTask(emptyTaskSnapshot(), request({ assignee: null }), context());

    // Assert
    should(outcome.entry.task.assignee).be.null();
    should(lastActivity(outcome.entry).data).not.have.property('assignee');
  });

  it('should record advisory file claims supplied at creation in history', () => {
    // Act
    const outcome = createTask(emptyTaskSnapshot(), request({ files: ['src/a.ts', 'src/a.ts'] }), context());

    // Assert — the duplicate is collapsed, not carried
    should(outcome.entry.task.files).eql(['src/a.ts']);
    should(lastActivity(outcome.entry).data).have.property('files', ['src/a.ts']);
  });

  it('should collapse a duplicate dependency rather than storing the edge twice', () => {
    // Arrange
    const snapshot = snapshotOf(task({ id: id('F1') }));

    // Act
    const outcome = createTask(snapshot, request({ dependsOn: [id('F1'), id('F1')] }), context());

    // Assert
    should(outcome.entry.task.dependsOn).eql(['F1']);
  });

  it.each(['blocked', 'dropped'] as const)('should require a reason to create %s work', status => {
    // Act & Assert
    shouldRefuse('invalid', () => createTask(emptyTaskSnapshot(), request({ status }), context()));
  });

  it('should keep the reason that justified creating blocked work', () => {
    // Act
    const outcome = createTask(
      emptyTaskSnapshot(),
      request({ status: 'blocked', statusReason: 'waiting on the vendor' }),
      context(),
    );

    // Assert
    should(outcome.entry.task.status).equal('blocked');
    should(outcome.entry.task.phase).equal('todo');
    should(outcome.entry.task.statusReason).equal('waiting on the vendor');
    should(lastActivity(outcome.entry).data).have.property('reason', 'waiting on the vendor');
  });

  it('should refuse a title the ubiquitous language caps at five words', () => {
    // Act & Assert
    shouldRefuse('invalid', () =>
      createTask(emptyTaskSnapshot(), request({ title: 'Ship the whole board today please' }), context()),
    );
  });

  it('should refuse a status that is not part of the chosen workflow', () => {
    // Act & Assert — 'quick' has no design phase
    shouldRefuse('invalid', () =>
      createTask(emptyTaskSnapshot(), request({ workflow: 'quick', status: 'designed' }), context()),
    );
  });

  it('should refuse an edge to a task that does not exist', () => {
    // Act & Assert
    shouldRefuse('not-found', () => createTask(emptyTaskSnapshot(), request({ dependsOn: [id('F9')] }), context()));
  });

  it('should refuse an agent writing a board that is not its own session', () => {
    // Act & Assert
    shouldRefuse('forbidden', () =>
      createTask(emptyTaskSnapshot(), request(), context(agent({ sessionId: 'session-beta' }))),
    );
  });

  it('should let a human write any board', () => {
    // Act
    const outcome = createTask(emptyTaskSnapshot(), request(), context(human()));

    // Assert
    should(outcome.entry.task.createdBy).equal('operator');
  });

  it('should refuse more dependencies than the protocol admits', () => {
    // Arrange
    const dependencies = Array.from({ length: MAX_TASK_DEPENDENCIES + 1 }, (_, index) => id(`F${index + 1}`));

    // Act & Assert
    shouldRefuse('invalid', () => createTask(emptyTaskSnapshot(), request({ dependsOn: dependencies }), context()));
  });
});

describe('requireTaskEntry', () => {
  it('should resolve a lower-case reference to the canonical record', () => {
    // Arrange
    const snapshot = snapshotOf(task({ id: id('F7') }));

    // Act
    const actual = requireTaskEntry(snapshot, 'f7');

    // Assert
    should(actual.task.id).equal('F7');
  });

  it.each(['F9', 'not-a-task'])('should refuse the unknown reference %p', reference => {
    // Act & Assert
    shouldRefuse('not-found', () => requireTaskEntry(snapshotOf(task()), reference));
  });
});

describe('applyLink', () => {
  const links = (): TaskLinks => ({ prs: [], branch: null, commits: [], docs: [] });

  it('should replace the single branch rather than accumulating branches', () => {
    // Act
    const actual = applyLink(applyLink(links(), 'branch', 'port/a'), 'branch', 'port/b');

    // Assert
    should(actual.branch).equal('port/b');
  });

  it.each([
    { field: 'pr', key: 'prs' },
    { field: 'commit', key: 'commits' },
    { field: 'doc', key: 'docs' },
  ] as const)('should append a $field without duplicating it', ({ field, key }) => {
    // Act
    const actual = applyLink(applyLink(links(), field, 'value'), field, 'value');

    // Assert
    should(actual[key]).eql(['value']);
  });

  it('should refuse more links than the protocol admits for one field', () => {
    // Arrange
    const full = { ...links(), prs: Array.from({ length: MAX_TASK_LINKS_PER_FIELD }, (_, index) => `pr-${index}`) };

    // Act & Assert
    shouldRefuse('too-long', () => applyLink(full, 'pr', 'one-too-many'));
  });
});

describe('applyTaskAction — status and phase', () => {
  it('should advance one adjacent phase and stamp the move', () => {
    // Arrange
    const snapshot = snapshotOf(task());

    // Act
    const outcome = act(snapshot, 'F1', { action: 'phase', phase: 'build', reason: 'starting work' });

    // Assert
    should(outcome.entry.task.phase).equal('build');
    should(outcome.entry.task.status).equal('in_progress');
    should(outcome.entry.task.updatedAt).equal(LATER_INSTANT);
    should(lastActivity(outcome.entry).data).containEql({
      from: 'todo',
      to: 'in_progress',
      phaseFrom: 'todo',
      phaseTo: 'build',
      reason: 'starting work',
    });
  });

  it('should persist the reason for a forward move on the record, not only in history', () => {
    // Arrange
    const snapshot = snapshotOf(task());

    // Act
    const outcome = act(snapshot, 'F1', { action: 'status', status: 'in_progress', reason: 'picked it up' });

    // Assert — kteam wrote null here and the board could not say why it moved
    should(outcome.entry.task.statusReason).equal('picked it up');
  });

  it('should refuse a forward skip across the workflow', () => {
    // Act & Assert
    const error = shouldRefuse('transition', () =>
      act(snapshotOf(task()), 'F1', { action: 'phase', phase: 'built', reason: 'looks done' }),
    );
    should(error.message).containEql('skip forward');
  });

  it('should refuse a phase that is not part of the task workflow', () => {
    // Act & Assert
    shouldRefuse('transition', () =>
      act(snapshotOf(task({ workflow: 'quick' })), 'F1', { action: 'phase', phase: 'design', reason: 'design first' }),
    );
  });

  it('should refuse a move to the phase the task already occupies', () => {
    // Act & Assert
    shouldRefuse('transition', () =>
      act(snapshotOf(task()), 'F1', { action: 'phase', phase: 'todo', reason: 'no-op' }),
    );
  });

  it('should refuse live to done without a human verifying it', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));

    // Act & Assert
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'it works' }),
    );
  });

  it('should let a human verify live to done and record the verification', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'checked it' }, human());

    // Assert
    should(outcome.entry.task.phase).equal('done');
    should(lastActivity(outcome.entry).data).have.property('verifiedByHuman', true);
    should(lastActivity(outcome.entry).data).not.have.property('verifiedByTopAgent');
    // The positive stamp is what earns this record its trust on read; a human attestation without
    // it reads as unreliable no matter when it was written.
    should(lastActivity(outcome.entry).data).have.property('attestationSemantics', ACTOR_AUTHORITY_SPLIT_SEMANTICS);
    should(markLegacyAttestations([lastActivity(outcome.entry)])[0]?.data).not.have.property('legacyAttestation');
  });

  it('should let a human complete a blocked live task and attest the phase transition', () => {
    // A manual block overlays status only. The workflow is still live, so clearing it directly by
    // completing the task must validate and journal `phase: live → done`, not insist that status
    // had already been separately restored to live.
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'live', status: 'blocked', statusReason: 'waiting on validation' }));

    // Act
    const outcome = act(
      snapshot,
      'F1',
      { action: 'status', status: 'done', reason: 'validated after unblock' },
      human(),
    );

    // Assert
    const recorded = lastActivity(outcome.entry);
    should(outcome.entry.task).containEql({ phase: 'done', status: 'done' });
    should(recorded.data).containEql({
      from: 'blocked',
      to: 'done',
      phaseFrom: 'live',
      phaseTo: 'done',
      verifiedByHuman: true,
      attestationSemantics: ACTOR_AUTHORITY_SPLIT_SEMANTICS,
    });
  });

  it('should record a board-granted agent as the top agent, with the grant it acted under', () => {
    // Arrange — the actor shape the task mount produces after a `mark_done` authorization.
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'shipped it' }, topAgent());

    // Assert
    should(outcome.entry.task.phase).equal('done');
    const recorded = lastActivity(outcome.entry);
    // POSITIVE on both halves: which kind of attestation, and which grant produced it. A reader
    // never has to infer either from the absence of the other flag.
    should(recorded.data).have.property('verifiedByTopAgent', true);
    should(recorded.data).have.property('authorization', MARK_DONE_GRANT);
    should(recorded.data).have.property('attestationSemantics', ACTOR_AUTHORITY_SPLIT_SEMANTICS);
    // The whole defect: a peer completion journalled as a human verification.
    should(recorded.data).not.have.property('verifiedByHuman');
    should(recorded.actor).equal(`peer:${SESSION_ID}`);
  });

  it('should let a top agent complete a blocked live task with its exact receipt', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'live', status: 'blocked', statusReason: 'awaiting final check' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'shipped it' }, topAgent());

    // Assert
    const recorded = lastActivity(outcome.entry);
    should(outcome.entry.task).containEql({ phase: 'done', status: 'done' });
    should(recorded.data).containEql({
      from: 'blocked',
      to: 'done',
      phaseFrom: 'live',
      phaseTo: 'done',
      verifiedByTopAgent: true,
      authorization: MARK_DONE_GRANT,
      attestationSemantics: ACTOR_AUTHORITY_SPLIT_SEMANTICS,
    });
  });

  it('should refuse malformed or mismatched top-agent evidence without writing a completion', () => {
    // Arrange — this is the reducer boundary, so a caller can hand it an object that never travelled
    // through the task-board mount. It must validate the receipt rather than trusting its presence.
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));
    const malformed = agent({
      boardAuthorizedForSession: SESSION_ID,
      markDoneAuthorization: { ...MARK_DONE_GRANT, role: 'read', action: 'note' },
    });

    // Act + Assert
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'shipped it' }, malformed),
    );
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'a different click' }, topAgent()),
    );
    should(snapshot.tasks[0]?.task.phase).equal('live');
    should(snapshot.tasks[0]?.activity).have.length(1);
  });

  it('should refuse live to done to an agent whose grant did not name this session', () => {
    // Arrange — authorized for a DIFFERENT session, so the grant proves nothing here.
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));
    const elsewhere = agent({ boardAuthorizedForSession: 'session-beta' });

    // Act + Assert
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'not mine to close' }, elsewhere),
    );
  });

  it.each([
    {
      name: 'reopening shipped work',
      seed: { phase: 'done', status: 'done' },
      action: { action: 'reopen', reason: 'regressed', ask: 'fix it', source: 'human:cli' },
    },
    {
      name: 'advancing past design',
      seed: { workflow: 'design-first', phase: 'design', status: 'designed' },
      action: { action: 'phase', phase: 'build', reason: 'design is settled' },
    },
    {
      name: 'advancing past research',
      seed: { workflow: 'research-first', phase: 'research', status: 'researched' },
      action: { action: 'phase', phase: 'design', reason: 'research is done' },
    },
  ] as const)('should refuse $name to a mark-done grant', ({ seed, action }) => {
    // Arrange
    const snapshot = snapshotOf(task(seed));

    // Act + Assert — the grant authorizes live → done, and that is the whole of it.
    shouldRefuse('approval-required', () => act(snapshot, 'F1', action, topAgent()));
  });

  it('should require human approval to leave a design phase', () => {
    // Arrange
    const snapshot = snapshotOf(task({ workflow: 'design-first', phase: 'design', status: 'designed' }));

    // Act & Assert
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'phase', phase: 'build', reason: 'design is settled' }),
    );
  });

  it('should mark a human-approved exit from a design phase', () => {
    // Arrange
    const snapshot = snapshotOf(task({ workflow: 'design-first', phase: 'design', status: 'designed' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'phase', phase: 'build', reason: 'approved' }, human());

    // Assert
    should(lastActivity(outcome.entry).data).have.property('approvedByHuman', true);
    // The other attestation the old predicate could falsify, so it carries the stamp too.
    should(lastActivity(outcome.entry).data).have.property('attestationSemantics', ACTOR_AUTHORITY_SPLIT_SEMANTICS);
  });

  it.each([
    { workflow: 'research-first' as const, phase: 'research' as const, status: 'researched' as const },
    { workflow: 'design-first' as const, phase: 'design' as const, status: 'designed' as const },
  ])(
    'should not mistake clearing a blocked $phase phase for human workflow approval',
    ({ workflow, phase, status }) => {
      // Arrange — a same-phase status action only clears the manual block; it does not move through a
      // human gate, so it must not mint the durable approval attestation.
      const snapshot = snapshotOf(task({ workflow, phase, status: 'blocked', statusReason: 'waiting on input' }));

      // Act
      const outcome = act(snapshot, 'F1', { action: 'status', status, reason: 'input arrived' }, human());

      // Assert
      const recorded = lastActivity(outcome.entry);
      should(recorded.data).not.have.property('approvedByHuman');
      should(recorded.data).not.have.property('attestationSemantics');
    },
  );

  it('should replay the exact latest peer completion without another activity', () => {
    // Arrange
    const action = { action: 'status', status: 'done', reason: 'shipped it' } as const;
    const completed = act(snapshotOf(task({ phase: 'live', status: 'live' })), 'F1', action, topAgent());
    const retryingActor = {
      ...topAgent(),
      doneRequestIdentity: {
        requestId: 'click-1',
        fingerprint: { action: 'status', status: 'done', reason: 'shipped it' } as const,
      },
    };

    // Act
    const replayed = act(completed.snapshot, 'F1', action, retryingActor);

    // Assert — the exact same snapshot object returns from the reducer transaction; no history is appended.
    should(replayed.snapshot).equal(completed.snapshot);
    should(replayed.entry).equal(completed.entry);
    should(replayed.entry.activity).have.length(completed.entry.activity.length);
  });

  it('should refuse an incoherent peer replay identity before applying any transition', () => {
    // Arrange — direct reducer callers must not turn a mismatched identity/body pair into an
    // ordinary completion attempt, even before a durable receipt exists to compare it against.
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));
    const malformedIdentity = {
      ...topAgent(),
      doneRequestIdentity: {
        requestId: 'click-1',
        fingerprint: { action: 'status', status: 'done', reason: 'a different click' } as const,
      },
    };

    // Act + Assert
    shouldRefuse('invalid', () =>
      act(snapshot, 'F1', { action: 'status', status: 'done', reason: 'shipped it' }, malformedIdentity),
    );
    should(snapshot.tasks[0]?.task.phase).equal('live');
    should(snapshot.tasks[0]?.activity).have.length(1);
  });

  it('should refuse a reused peer completion id when its body or lifecycle no longer matches', () => {
    // Arrange
    const completion = act(
      snapshotOf(task({ phase: 'live', status: 'live' })),
      'F1',
      { action: 'status', status: 'done', reason: 'shipped it' },
      topAgent(),
    );
    const sameIdDifferentBody = {
      ...topAgent(),
      doneRequestIdentity: {
        requestId: 'click-1',
        fingerprint: { action: 'status', status: 'done', reason: 'changed body' } as const,
      },
    };
    const reopened = act(
      completion.snapshot,
      'F1',
      { action: 'reopen', reason: 'regressed', ask: 'fix it', source: 'human:cli' },
      human(),
    );
    const staleRetry = {
      ...topAgent(),
      doneRequestIdentity: {
        requestId: 'click-1',
        fingerprint: { action: 'status', status: 'done', reason: 'shipped it' } as const,
      },
    };
    const otherActorSameId = {
      ...topAgent(),
      id: 'another-peer',
      sessionId: 'session-beta',
      boardAuthorizedForSession: SESSION_ID,
      doneRequestIdentity: {
        requestId: 'click-1',
        fingerprint: { action: 'status', status: 'done', reason: 'shipped it' } as const,
      },
    };

    // Act + Assert
    shouldRefuse('transition', () =>
      act(completion.snapshot, 'F1', { action: 'status', status: 'done', reason: 'changed body' }, sameIdDifferentBody),
    );
    shouldRefuse('transition', () =>
      act(reopened.snapshot, 'F1', { action: 'status', status: 'done', reason: 'shipped it' }, staleRetry),
    );
    shouldRefuse('transition', () =>
      act(completion.snapshot, 'F1', { action: 'status', status: 'done', reason: 'shipped it' }, otherActorSameId),
    );
    should(completion.entry.task.phase).equal('done');
    should(completion.entry.activity).have.length(2);
    should(reopened.entry.task.phase).equal('build');
    should(reopened.entry.activity).have.length(4);
  });

  it('should allow a rewind and flag it as backward', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'build', status: 'in_progress' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'phase', phase: 'todo', reason: 'wrong approach' });

    // Assert
    should(outcome.entry.task.phase).equal('todo');
    should(outcome.entry.task.statusReason).equal('wrong approach');
    should(lastActivity(outcome.entry).data).have.property('backward', true);
  });

  it('should refuse an agent reopening human-verified done work', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'done', status: 'done' }));

    // Act & Assert
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'phase', phase: 'live', reason: 'not actually done' }),
    );
  });

  it('should refuse moving a dropped task at all', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'dropped', status: 'dropped', statusReason: 'obsolete' }));

    // Act & Assert
    shouldRefuse('transition', () => act(snapshot, 'F1', { action: 'phase', phase: 'todo', reason: 'revive' }));
  });

  it('should block a task in place, keeping its phase and its stated blocker', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'build', status: 'in_progress' }));

    // Act
    const outcome = act(snapshot, 'F1', {
      action: 'status',
      status: 'blocked',
      reason: 'waiting on review',
      note: 'pinged',
    });

    // Assert
    should(outcome.entry.task.status).equal('blocked');
    should(outcome.entry.task.phase).equal('build');
    should(outcome.entry.task.statusReason).equal('waiting on review');
    should(lastActivity(outcome.entry).data).containEql({ phaseFrom: 'build', phaseTo: 'build', note: 'pinged' });
  });

  it('should clear a manual block by restating the phase it was blocked in', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'build', status: 'blocked', statusReason: 'waiting on review' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'status', status: 'in_progress', reason: 'review landed' });

    // Assert
    should(outcome.entry.task.status).equal('in_progress');
    should(outcome.entry.task.statusReason).equal('review landed');
  });

  it('should refuse dropping work another live task still depends on', () => {
    // Arrange
    const snapshot = snapshotOf(task({ id: id('F1'), dependsOn: [id('F2')] }), task({ id: id('F2') }));

    // Act & Assert
    shouldRefuse('dependency-conflict', () =>
      act(snapshot, 'F2', { action: 'status', status: 'dropped', reason: 'not needed' }),
    );
  });

  it('should drop work nothing waits on and keep the reason', () => {
    // Arrange
    const snapshot = snapshotOf(task());

    // Act
    const outcome = act(snapshot, 'F1', { action: 'status', status: 'dropped', reason: 'superseded' });

    // Assert
    should(outcome.entry.task.status).equal('dropped');
    should(outcome.entry.task.phase).equal('dropped');
    should(outcome.entry.task.statusReason).equal('superseded');
  });
});

describe('applyTaskAction — reopen', () => {
  it('should land the new ask and the move together', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'built', status: 'built' }));

    // Act
    const outcome = act(snapshot, 'F1', {
      action: 'reopen',
      reason: 'the human found a defect',
      ask: 'it drops the last row',
      source: 'human:cli',
    });

    // Assert — the clarification and the status entry are one indivisible append
    should(outcome.entry.task.phase).equal('build');
    should(outcome.entry.task.clarifications).have.length(1);
    should(outcome.entry.task.clarifications[0]).containEql({ text: 'it drops the last row', source: 'human:cli' });
    should(outcome.entry.activity.map(item => item.type)).eql(['created', 'clarification', 'status']);
    should(outcome.entry.activity.map(item => item.seq)).eql([1, 2, 3]);
    should(lastActivity(outcome.entry).data).have.property('backward', true);
  });

  it('should mark a reopen of shipped work as reopened', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'live', status: 'live' }));

    // Act
    const outcome = act(snapshot, 'F1', {
      action: 'reopen',
      reason: 'regression',
      ask: 'roll it back',
      source: 'human:cli',
    });

    // Assert
    should(lastActivity(outcome.entry).data).have.property('reopened', true);
  });

  it('should refuse reopening work that was never shipped', () => {
    // Act & Assert
    shouldRefuse('transition', () =>
      act(snapshotOf(task()), 'F1', { action: 'reopen', reason: 'r', ask: 'a', source: 's' }),
    );
  });

  it('should refuse an agent reopening done work, which only a human may reverse', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'done', status: 'done' }));

    // Act & Assert
    shouldRefuse('approval-required', () =>
      act(snapshot, 'F1', { action: 'reopen', reason: 'r', ask: 'a', source: 's' }),
    );
  });

  it('should refuse a plain phase move back into build without the reopen context', () => {
    // Arrange
    const snapshot = snapshotOf(task({ phase: 'built', status: 'built' }));

    // Act & Assert
    const error = shouldRefuse('transition', () =>
      act(snapshot, 'F1', { action: 'phase', phase: 'build', reason: 'more work' }),
    );
    should(error.message).containEql('reopen');
  });
});

describe('applyTaskAction — notes and clarifications', () => {
  it.each(['note', 'feedback'] as const)('should append a %s without touching the record', action => {
    // Arrange
    const snapshot = snapshotOf(task());

    // Act
    const outcome = act(snapshot, 'F1', { action, text: 'a remark' });

    // Assert
    should(outcome.entry.task.phase).equal('todo');
    should(lastActivity(outcome.entry)).containEql({ type: action, seq: 2 });
    should(lastActivity(outcome.entry).data).have.property('text', 'a remark');
  });

  it('should attribute a clarification to its actor and instant', () => {
    // Arrange
    const snapshot = snapshotOf(task());

    // Act
    const outcome = act(snapshot, 'F1', { action: 'clarify', text: 'also the CSV path', source: 'human:cli' });

    // Assert
    should(outcome.entry.task.clarifications[0]).eql({
      text: 'also the CSV path',
      source: 'human:cli',
      at: LATER_INSTANT,
      by: 'wilfredo',
      byName: 'Wilfredo',
    });
  });

  it('should refuse more clarifications than the protocol admits', () => {
    // Arrange
    const full = task({
      clarifications: Array.from({ length: MAX_TASK_CLARIFICATIONS }, () => ({
        text: 'x',
        source: 'human',
        at: LATER_INSTANT,
        by: 'wilfredo',
        byName: null,
      })),
    });

    // Act & Assert
    shouldRefuse('too-long', () =>
      act(snapshotOf(full), 'F1', { action: 'clarify', text: 'one more', source: 'human' }),
    );
  });

  it('should number history gap-free from its length, so a lost line cannot desynchronise it', () => {
    // Arrange
    const first = act(snapshotOf(task()), 'F1', { action: 'note', text: 'one' });

    // Act
    const second = act(first.snapshot, 'F1', { action: 'note', text: 'two' });

    // Assert
    should(second.entry.activity.map(item => item.seq)).eql([1, 2, 3]);
  });
});

describe('applyTaskAction — dependencies', () => {
  const two = () => snapshotOf(task({ id: id('F1') }), task({ id: id('F2') }));

  it('should add an edge and record it', () => {
    // Act
    const outcome = act(two(), 'F1', { action: 'dependency', taskId: id('F2') });

    // Assert
    should(outcome.entry.task.dependsOn).eql(['F2']);
    should(lastActivity(outcome.entry).data).containEql({ taskId: 'F2', operation: 'add' });
  });

  it('should remove an edge it declared', () => {
    // Arrange
    const snapshot = snapshotOf(task({ id: id('F1'), dependsOn: [id('F2')] }), task({ id: id('F2') }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'dependency', taskId: id('F2'), remove: true });

    // Assert
    should(outcome.entry.task.dependsOn).be.empty();
    should(lastActivity(outcome.entry).data).containEql({ operation: 'remove' });
  });

  it('should refuse a self-edge', () => {
    // Act & Assert
    shouldRefuse('cycle', () => act(two(), 'F1', { action: 'dependency', taskId: id('F1') }));
  });

  it('should refuse an edge that closes a cycle several hops away', () => {
    // Arrange
    const snapshot = snapshotOf(
      task({ id: id('F1'), dependsOn: [id('F2')] }),
      task({ id: id('F2'), dependsOn: [id('F3')] }),
      task({ id: id('F3') }),
    );

    // Act & Assert
    shouldRefuse('cycle', () => act(snapshot, 'F3', { action: 'dependency', taskId: id('F1') }));
  });

  it('should refuse an edge to a task that does not exist', () => {
    // Act & Assert
    shouldRefuse('not-found', () => act(two(), 'F1', { action: 'dependency', taskId: id('F9') }));
  });

  it('should refuse adding an edge that already exists', () => {
    // Arrange
    const snapshot = snapshotOf(task({ id: id('F1'), dependsOn: [id('F2')] }), task({ id: id('F2') }));

    // Act & Assert
    shouldRefuse('invalid', () => act(snapshot, 'F1', { action: 'dependency', taskId: id('F2') }));
  });

  it('should refuse more edges than the protocol admits', () => {
    // Arrange
    const full = task({
      id: id('F1'),
      dependsOn: Array.from({ length: MAX_TASK_DEPENDENCIES }, (_, index) => id(`F${index + 10}`)),
    });

    // Act & Assert
    shouldRefuse('too-long', () => act(snapshotOf(full), 'F1', { action: 'dependency', taskId: id('F2') }));
  });

  it('should refuse removing an edge that was never declared', () => {
    // Act & Assert
    shouldRefuse('invalid', () => act(two(), 'F1', { action: 'dependency', taskId: id('F2'), remove: true }));
  });
});

describe('applyTaskAction — advisory file claims', () => {
  it('should claim a path without consulting any other task claiming it', () => {
    // Arrange — F2 already claims the same path; a claim is documentation, never a lock
    const snapshot = snapshotOf(task({ id: id('F1') }), task({ id: id('F2'), files: ['src/a.ts'] }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'file', path: 'src/a.ts', reason: 'refactoring it' });

    // Assert
    should(outcome.entry.task.files).eql(['src/a.ts']);
    should(lastActivity(outcome.entry).data).containEql({ operation: 'add', reason: 'refactoring it' });
  });

  it('should release a claim it holds', () => {
    // Arrange
    const snapshot = snapshotOf(task({ files: ['src/a.ts'] }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'file', path: 'src/a.ts', remove: true });

    // Assert
    should(outcome.entry.task.files).be.empty();
  });

  it('should refuse claiming a path it already claims', () => {
    // Act & Assert
    shouldRefuse('invalid', () =>
      act(snapshotOf(task({ files: ['src/a.ts'] })), 'F1', { action: 'file', path: 'src/a.ts' }),
    );
  });

  it('should refuse releasing a path it never claimed', () => {
    // Act & Assert
    shouldRefuse('invalid', () => act(snapshotOf(task()), 'F1', { action: 'file', path: 'src/a.ts', remove: true }));
  });

  it('should refuse more claims than the protocol admits', () => {
    // Arrange
    const full = task({ files: Array.from({ length: MAX_TASK_FILES }, (_, index) => `src/f${index}.ts`) });

    // Act & Assert
    shouldRefuse('too-long', () => act(snapshotOf(full), 'F1', { action: 'file', path: 'src/extra.ts' }));
  });
});

describe('applyTaskAction — links, assignment, and order', () => {
  it('should link a pull request', () => {
    // Act
    const outcome = act(snapshotOf(task()), 'F1', { action: 'link', field: 'pr', value: 'https://example.test/pr/1' });

    // Assert
    should(outcome.entry.task.links.prs).eql(['https://example.test/pr/1']);
    should(lastActivity(outcome.entry).data).containEql({ field: 'pr' });
  });

  it('should reassign a task and record both sides of the move', () => {
    // Arrange
    const snapshot = snapshotOf(task({ assignee: 'wilfredo' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'assign', assignee: '  esperanza  ' });

    // Assert
    should(outcome.entry.task.assignee).equal('esperanza');
    should(lastActivity(outcome.entry).data).containEql({ from: 'wilfredo', to: 'esperanza' });
  });

  it('should unassign a task', () => {
    // Arrange
    const snapshot = snapshotOf(task({ assignee: 'wilfredo' }));

    // Act
    const outcome = act(snapshot, 'F1', { action: 'assign', assignee: null });

    // Assert
    should(outcome.entry.task.assignee).be.null();
  });

  it('should rank and unrank a task', () => {
    // Act
    const ranked = act(snapshotOf(task()), 'F1', { action: 'order', order: 3 });
    const unranked = act(ranked.snapshot, 'F1', { action: 'order', order: null });

    // Assert
    should(ranked.entry.task.order).equal(3);
    should(unranked.entry.task.order).be.null();
    should(lastActivity(unranked.entry).data).containEql({ from: 3, to: null });
  });
});

describe('applyTaskAction — refusals', () => {
  it('should refuse an action against an unknown task', () => {
    // Act & Assert
    shouldRefuse('not-found', () => act(snapshotOf(task()), 'F9', { action: 'note', text: 'hello' }));
  });

  it('should refuse a malformed action rather than half-applying it', () => {
    // Act & Assert
    shouldRefuse('invalid', () =>
      act(snapshotOf(task()), 'F1', { action: 'note', text: '' } as unknown as TaskActionRequest),
    );
  });

  it('should refuse an agent acting on a board that is not its own session', () => {
    // Act & Assert
    shouldRefuse('forbidden', () =>
      act(snapshotOf(task()), 'F1', { action: 'note', text: 'hello' }, agent({ sessionId: 'session-beta' })),
    );
  });

  it('should leave the caller snapshot untouched when a mutation is applied', () => {
    // Arrange
    const snapshot = snapshotOf(task());

    // Act
    act(snapshot, 'F1', { action: 'note', text: 'a remark' });

    // Assert
    should(snapshot.tasks[0]?.activity).have.length(1);
  });
});
