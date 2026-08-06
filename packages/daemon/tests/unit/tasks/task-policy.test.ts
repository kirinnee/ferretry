import { describe, it } from 'bun:test';
import type { Task, TaskPhase, TaskStatus, TaskWorkflow } from '@ferretry/protocol';
import should from 'should';
import { TaskError } from '../../../src/lib/tasks/task-error.ts';
import { MARK_DONE_GRANT } from './fixtures.ts';
import {
  TASK_WORKFLOW_PATHS,
  assertActorCanWriteSession,
  assertTaskPhaseTransition,
  assertTransitionReason,
  canActorWriteSession,
  canAddAdvisoryFileClaim,
  creationRequiresReason,
  hasReopenContext,
  hasRequiredCreationReason,
  hasTransitionReason,
  isForwardPhaseSkip,
  isHumanActor,
  canActorVerifyTaskDone,
  requiresHumanLiveVerification,
  requiresHumanWorkflowApproval,
  requiresReopenAction,
  taskPhaseFromStatus,
  taskPhaseMovesBackward,
  taskStatusFromPhase,
  taskWorkflowPath,
  type TaskActor,
} from '../../../src/lib/tasks/task-policy.ts';

const STATUS_BY_PHASE: Readonly<Record<TaskPhase, TaskStatus>> = {
  todo: 'todo',
  research: 'researched',
  design: 'designed',
  build: 'in_progress',
  built: 'built',
  live: 'live',
  done: 'done',
  dropped: 'dropped',
};

const task = (workflow: TaskWorkflow, phase: TaskPhase, overrides: Partial<Task> = {}): Task => ({
  v: 1,
  id: 'F1',
  kind: 'feature',
  title: 'Build task core',
  description: '',
  ask: { text: 'Build it', source: 'message:1' },
  clarifications: [],
  workflow,
  phase,
  dependsOn: [],
  status: STATUS_BY_PHASE[phase],
  statusReason: phase === 'dropped' ? 'no longer needed' : null,
  assignee: null,
  repo: null,
  files: [],
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-30T18:00:00.000Z',
  createdBy: 'actor-1',
  updatedAt: '2026-07-30T18:00:00.000Z',
  ...overrides,
});

const actor = (kind: TaskActor['kind'], sessionId: string | null): TaskActor => ({
  kind,
  id: `${kind}-1`,
  name: null,
  sessionId,
});

/** An actor as the task mount leaves it after a shared-board `mark_done` authorization. */
const granted = (base: TaskActor): TaskActor => ({
  ...base,
  boardAuthorizedForSession: base.sessionId ?? 'session-a',
  markDoneAuthorization: MARK_DONE_GRANT,
});

const thrownTaskError = (operation: () => void): TaskError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof TaskError) return error;
    throw error;
  }
  throw new Error('expected TaskError');
};

describe('task workflow tables', () => {
  it.each([
    { workflow: 'quick', expected: ['todo', 'build', 'built', 'live', 'done'] },
    { workflow: 'design-first', expected: ['todo', 'design', 'build', 'built', 'live', 'done'] },
    {
      workflow: 'research-first',
      expected: ['todo', 'research', 'design', 'build', 'built', 'live', 'done'],
    },
    { workflow: 'investigate', expected: ['todo', 'research', 'done'] },
  ] as const)('should expose the fixed $workflow workflow path', ({ workflow, expected }) => {
    // Act
    const actual = taskWorkflowPath(workflow);

    // Assert
    should(actual).deepEqual(expected);
    should(Object.isFrozen(actual)).be.true();
  });

  it.each([
    ['todo', 'todo'],
    ['researched', 'research'],
    ['designed', 'design'],
    ['in_progress', 'build'],
    ['built', 'built'],
    ['live', 'live'],
    ['done', 'done'],
    ['blocked', 'todo'],
    ['dropped', 'dropped'],
  ] as const)('should map status %s to phase %s', (status, expected) => {
    // Act + Assert
    should(taskPhaseFromStatus(status)).equal(expected);
    if (status !== 'blocked') should(taskStatusFromPhase(expected)).equal(status);
  });

  it('should keep the workflow table immutable', () => {
    // Act + Assert
    should(Object.isFrozen(TASK_WORKFLOW_PATHS)).be.true();
  });
});

describe('transition reason predicates', () => {
  it.each([
    { input: undefined, expected: false },
    { input: '', expected: false },
    { input: ' \n\t ', expected: false },
    { input: 'because the test passed', expected: true },
  ])('should classify "$input" as nonblank=$expected', ({ input, expected }) => {
    // Act + Assert
    should(hasTransitionReason(input)).equal(expected);
  });

  it.each([
    { status: 'todo', reason: undefined, expected: true },
    { status: 'blocked', reason: undefined, expected: false },
    { status: 'blocked', reason: ' ', expected: false },
    { status: 'blocked', reason: 'needs a key', expected: true },
    { status: 'dropped', reason: 'superseded', expected: true },
  ] as const)('should enforce the creation reason rule for $status', ({ status, reason, expected }) => {
    // Act + Assert
    should(creationRequiresReason(status)).equal(status === 'blocked' || status === 'dropped');
    should(hasRequiredCreationReason(status, reason)).equal(expected);
  });

  it('should throw the reason-required protocol code for a blank move reason', () => {
    // Act
    const actual = thrownTaskError(() => assertTransitionReason('  '));

    // Assert
    should(actual.code).equal('reason-required');
  });
});

describe('reopen predicates', () => {
  it.each([
    { ask: 'new ask', source: 'message:2', expected: true },
    { ask: '', source: 'message:2', expected: false },
    { ask: 'new ask', source: ' ', expected: false },
  ])('should require a nonblank ask and source', ({ ask, source, expected }) => {
    // Act + Assert
    should(hasReopenContext(ask, source)).equal(expected);
  });

  it.each(['built', 'live', 'done'] as const)('should require reopen for %s → build', phase => {
    // Arrange
    const input = task('quick', phase);

    // Act + Assert
    should(requiresReopenAction(input, 'build')).be.true();
    should(() => assertTaskPhaseTransition(input, 'build', { human: true, verifiesDone: true, reopen: false })).throw(
      /must use reopen/u,
    );
    should(() =>
      assertTaskPhaseTransition(input, 'build', { human: true, verifiesDone: true, reopen: true }),
    ).not.throw();
  });

  it('should require a human actor to reopen human-verified done', () => {
    // Arrange
    const input = task('quick', 'done');

    // Act
    const actual = thrownTaskError(() =>
      assertTaskPhaseTransition(input, 'build', { human: false, verifiesDone: false, reopen: true }),
    );

    // Assert
    should(actual.code).equal('approval-required');
  });
});

describe('identity versus board authorization', () => {
  it.each([
    { name: 'a human', input: actor('human', null), human: true, verifies: true },
    { name: 'the daemon', input: actor('daemon', null), human: false, verifies: false },
    { name: 'a plain agent', input: actor('agent', 'session-a'), human: false, verifies: false },
    { name: 'a granted agent', input: granted(actor('agent', 'session-a')), human: false, verifies: true },
    {
      name: 'an agent authorized for a session without the grant',
      input: { ...actor('agent', 'session-a'), boardAuthorizedForSession: 'session-b' },
      human: false,
      verifies: false,
    },
  ])('should read $name as human=$human, verifies=$verifies', ({ input, human, verifies }) => {
    // Act + Assert
    should(isHumanActor(input)).equal(human);
    should(canActorVerifyTaskDone(input)).equal(verifies);
  });

  it('should let a board grant sign off live → done and nothing else', () => {
    // Arrange — the granted actor's two gate answers, as `movePhase` computes them.
    const options = { human: false, verifiesDone: true, reopen: false } as const;

    // Act + Assert — the one authorized move.
    should(() => assertTaskPhaseTransition(task('quick', 'live'), 'done', options)).not.throw();
    // …and every human-only gate the widened predicate used to satisfy.
    should(
      thrownTaskError(() => assertTaskPhaseTransition(task('research-first', 'research'), 'design', options)).code,
    ).equal('approval-required');
    should(
      thrownTaskError(() => assertTaskPhaseTransition(task('design-first', 'design'), 'build', options)).code,
    ).equal('approval-required');
    should(
      thrownTaskError(() => assertTaskPhaseTransition(task('quick', 'done'), 'build', { ...options, reopen: true }))
        .code,
    ).equal('approval-required');
  });

  it('should still refuse live → done to an agent holding no grant', () => {
    // Act
    const actual = thrownTaskError(() =>
      assertTaskPhaseTransition(task('quick', 'live'), 'done', {
        human: false,
        verifiesDone: false,
        reopen: false,
      }),
    );

    // Assert
    should(actual.code).equal('approval-required');
  });
});

describe('own-session write authorization', () => {
  it.each([
    { input: actor('agent', 'session-a'), target: 'session-a', expected: true },
    { input: actor('agent', 'session-a'), target: 'session-b', expected: false },
    { input: actor('human', null), target: 'session-b', expected: true },
    { input: actor('daemon', null), target: 'session-b', expected: true },
  ])('should return $expected for $input.kind writing $target', ({ input, target, expected }) => {
    // Act + Assert
    should(canActorWriteSession(input, target)).equal(expected);
  });

  it('should throw forbidden before an agent can write another session', () => {
    // Act
    const actual = thrownTaskError(() => assertActorCanWriteSession(actor('agent', 'session-a'), 'session-b'));

    // Assert
    should(actual.code).equal('forbidden');
  });
});

describe('file claim policy', () => {
  it('should allow a claim even when another task already advertises the same file', () => {
    // Arrange
    const graph = [task('quick', 'todo', { id: 'F1', files: ['src/shared.ts'] })];

    // Act
    const actual = canAddAdvisoryFileClaim(graph, 'F2', 'src/shared.ts');

    // Assert
    should(actual).be.true();
  });
});

describe('data-driven phase transitions', () => {
  it.each([
    { workflow: 'quick', from: 'todo', to: 'build', gated: false },
    { workflow: 'quick', from: 'build', to: 'built', gated: false },
    { workflow: 'quick', from: 'built', to: 'live', gated: false },
    { workflow: 'quick', from: 'live', to: 'done', gated: true },
    { workflow: 'design-first', from: 'todo', to: 'design', gated: false },
    { workflow: 'design-first', from: 'design', to: 'build', gated: true },
    { workflow: 'research-first', from: 'todo', to: 'research', gated: false },
    { workflow: 'research-first', from: 'research', to: 'design', gated: true },
    { workflow: 'research-first', from: 'design', to: 'build', gated: true },
    { workflow: 'investigate', from: 'todo', to: 'research', gated: false },
    { workflow: 'investigate', from: 'research', to: 'done', gated: true },
  ] as const)('should enforce $workflow $from → $to with human-gated=$gated', ({ workflow, from, to, gated }) => {
    // Arrange
    const input = task(workflow, from);

    // Act + Assert
    should(() => assertTaskPhaseTransition(input, to, { human: true, verifiesDone: true, reopen: false })).not.throw();
    if (gated) {
      should(() => assertTaskPhaseTransition(input, to, { human: false, verifiesDone: false, reopen: false })).throw(
        TaskError,
      );
    } else {
      should(() =>
        assertTaskPhaseTransition(input, to, { human: false, verifiesDone: false, reopen: false }),
      ).not.throw();
    }
  });

  it.each([
    { workflow: 'quick', to: 'built' },
    { workflow: 'design-first', to: 'build' },
    { workflow: 'research-first', to: 'design' },
    { workflow: 'investigate', to: 'done' },
  ] as const)('should refuse a forward skip in $workflow', ({ workflow, to }) => {
    // Arrange
    const input = task(workflow, 'todo');

    // Act
    const actual = thrownTaskError(() =>
      assertTaskPhaseTransition(input, to, { human: true, verifiesDone: true, reopen: false }),
    );

    // Assert
    should(isForwardPhaseSkip(input, to)).be.true();
    should(actual.code).equal('transition');
  });

  it('should expose research, design, and live gates as separate predicates', () => {
    // Arrange
    const research = task('research-first', 'research');
    const design = task('design-first', 'design');
    const live = task('quick', 'live');

    // Act + Assert
    should(requiresHumanWorkflowApproval(research, 'design')).be.true();
    should(requiresHumanWorkflowApproval(design, 'build')).be.true();
    should(requiresHumanLiveVerification(live, 'done')).be.true();
    should(requiresHumanWorkflowApproval(live, 'done')).be.false();
  });

  it('should permit backward deferral outside the shipped-to-build reopen boundary', () => {
    // Arrange
    const input = task('quick', 'built');

    // Act + Assert
    should(taskPhaseMovesBackward(input, 'todo')).be.true();
    should(() =>
      assertTaskPhaseTransition(input, 'todo', { human: false, verifiesDone: false, reopen: false }),
    ).not.throw();
  });

  it('should reject same-phase, foreign-workflow, and dropped-terminal moves', () => {
    // Arrange
    const quick = task('quick', 'build');
    const dropped = task('quick', 'dropped');

    // Act + Assert
    should(() => assertTaskPhaseTransition(quick, 'build', { human: true, verifiesDone: true, reopen: false })).throw(
      /already/u,
    );
    should(() => assertTaskPhaseTransition(quick, 'design', { human: true, verifiesDone: true, reopen: false })).throw(
      /not part/u,
    );
    should(() => assertTaskPhaseTransition(dropped, 'todo', { human: true, verifiesDone: true, reopen: false })).throw(
      /cannot move/u,
    );
  });
});
