import { describe, it } from 'bun:test';
import should from 'should';
import { buildStopPlan, callerAncestorIds, isStoppable, StopSelectorError } from '../../../src/lib/stop/plan';
import { ids, session } from './fixtures';

const FLEET = [
  session({ id: 'lead' }),
  session({ id: 'mid', parent: 'lead' }),
  session({ id: 'worker-a', parent: 'mid', teammate: 'ana', label: 'batch' }),
  session({ id: 'worker-b', parent: 'mid', teammate: 'bo', label: 'batch' }),
  session({ id: 'done', parent: 'mid', status: 'completed', label: 'batch' }),
  session({ id: 'outsider', label: 'other' }),
];

describe('stoppability', () => {
  it('should treat the four settled terminal states as unstoppable', () => {
    // Act + Assert
    for (const status of ['completed', 'failed', 'stalled', 'stopped'] as const) {
      should(isStoppable(session({ id: 'x', status }))).be.false();
    }
  });

  it('should keep kill_failed stoppable because another stop is its recovery path', () => {
    // Act + Assert
    should(isStoppable(session({ id: 'x', status: 'kill_failed' }))).be.true();
    should(isStoppable(session({ id: 'x', status: 'waiting' }))).be.true();
  });
});

describe('caller ancestry', () => {
  it('should walk the parent chain of the issuing session', () => {
    // Act
    const actual = callerAncestorIds(FLEET, 'worker-a');

    // Assert
    should([...actual].sort()).deepEqual(['lead', 'mid']);
  });

  it('should return nothing when no caller is known', () => {
    // Act + Assert
    should(callerAncestorIds(FLEET, undefined).size).equal(0);
    should(callerAncestorIds(FLEET, '   ').size).equal(0);
  });

  it('should return nothing when the caller is absent from the fleet', () => {
    // Act
    const actual = callerAncestorIds(FLEET, 'ghost');

    // Assert
    should(actual.size).equal(0);
  });

  it('should terminate on a parent cycle instead of recursing forever', () => {
    // Arrange
    const cyclic = [session({ id: 'a', parent: 'b' }), session({ id: 'b', parent: 'a' })];

    // Act
    const actual = callerAncestorIds(cyclic, 'a');

    // Assert
    should([...actual].sort()).deepEqual(['b']);
  });
});

describe('cascade selection', () => {
  it('should select the root and every stoppable transitive descendant, parents first', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' });

    // Assert
    should(ids(plan.targets)).deepEqual(['lead', 'mid', 'worker-a', 'worker-b']);
    should(plan.leftRunning).be.empty();
  });

  it('should order same-depth targets by teammate then id', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'cascade', rootId: 'mid' });

    // Assert
    should(ids(plan.targets)).deepEqual(['mid', 'worker-a', 'worker-b']);
  });

  it('should yield nothing when the root id names no session', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'cascade', rootId: 'ghost' });

    // Assert
    should(plan.targets).be.empty();
    should(plan.candidates).be.empty();
  });

  it('should reject a blank root id', () => {
    // Act + Assert
    should(() => buildStopPlan(FLEET, { kind: 'cascade', rootId: '  ' })).throw(StopSelectorError);
  });
});

describe('children selection', () => {
  it('should select descendants and leave the root running', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'children', rootId: 'lead' });

    // Assert
    should(ids(plan.targets)).deepEqual(['mid', 'worker-a', 'worker-b']);
  });
});

describe('orphan selection', () => {
  it('should select only the root and report the descendants left parentless', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'orphan', rootId: 'mid' });

    // Assert
    should(ids(plan.targets)).deepEqual(['mid']);
    should(ids(plan.leftRunning)).deepEqual(['worker-a', 'worker-b']);
  });
});

describe('label selection', () => {
  it('should select every stoppable session carrying the exact label', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'label', label: 'batch' });

    // Assert
    should(ids(plan.targets)).deepEqual(['worker-a', 'worker-b']);
  });

  it('should match a stored label that carries stray whitespace', () => {
    // Arrange — kteam compared a trimmed selector against an untrimmed stored label, so this missed.
    const fleet = [session({ id: 'padded', label: ' batch ' })];

    // Act
    const plan = buildStopPlan(fleet, { kind: 'label', label: 'batch' });

    // Assert
    should(ids(plan.targets)).deepEqual(['padded']);
  });

  it('should record lineage depth so nested matches sort under their parents', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'label', label: 'batch' });

    // Assert
    should(plan.targets.map(target => target.depth)).deepEqual([2, 2]);
  });

  it('should reject an empty label rather than select the whole fleet', () => {
    // Act + Assert
    should(() => buildStopPlan(FLEET, { kind: 'label', label: '   ' })).throw(StopSelectorError);
  });

  it('should ignore sessions with no label at all', () => {
    // Act
    const plan = buildStopPlan([session({ id: 'bare' })], { kind: 'label', label: 'batch' });

    // Assert
    should(plan.targets).be.empty();
  });
});

describe('caller safety', () => {
  it('should exclude the issuing session by default', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' }, { callerId: 'worker-a' });

    // Assert
    should(ids(plan.targets)).deepEqual(['lead', 'mid', 'worker-b']);
    should(ids(plan.excluded)).deepEqual(['worker-a']);
    should(plan.callerId).equal('worker-a');
  });

  it('should include the issuing session last when asked explicitly', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' }, { callerId: 'mid', includeCaller: true });

    // Assert
    should(ids(plan.targets)).deepEqual(['lead', 'worker-a', 'worker-b', 'mid']);
    should(plan.excluded).be.empty();
  });

  it('should flag ancestors of the caller as possible leads', () => {
    // Act
    const plan = buildStopPlan(FLEET, { kind: 'cascade', rootId: 'lead' }, { callerId: 'worker-a' });

    // Assert
    should(plan.targets.filter(target => target.callerAncestor).map(target => target.id)).deepEqual(['lead', 'mid']);
  });
});

describe('malformed records', () => {
  it('should skip sessions whose id is blank and keep the first record of a duplicate id', () => {
    // Arrange
    const fleet = [
      session({ id: '   ' }),
      session({ id: 'root' }),
      session({ id: 'dup', parent: 'root', name: 'first' }),
      session({ id: 'dup', parent: 'root', name: 'second' }),
    ];

    // Act
    const plan = buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' });

    // Assert
    should(ids(plan.targets)).deepEqual(['root', 'dup']);
    should(plan.targets[1]?.name).equal('first');
  });

  it('should treat a whitespace-only parent as no parent', () => {
    // Arrange
    const fleet = [session({ id: 'root' }), session({ id: 'loose', parent: '   ' })];

    // Act
    const plan = buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' });

    // Assert
    should(ids(plan.targets)).deepEqual(['root']);
  });

  it('should fall back to the id when the name is empty', () => {
    // Arrange
    const fleet = [session({ id: 'root', name: '' })];

    // Act
    const plan = buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' });

    // Assert
    should(plan.targets[0]?.name).equal('root');
  });

  it('should terminate a subtree walk that contains a parent cycle', () => {
    // Arrange
    const fleet = [session({ id: 'root' }), session({ id: 'a', parent: 'root' }), session({ id: 'root', parent: 'a' })];

    // Act
    const plan = buildStopPlan(fleet, { kind: 'cascade', rootId: 'root' });

    // Assert
    should(ids(plan.targets)).deepEqual(['root', 'a']);
  });

  it('should stop counting lineage depth when the chain loops', () => {
    // Arrange
    const fleet = [session({ id: 'a', parent: 'b', label: 'ring' }), session({ id: 'b', parent: 'a', label: 'ring' })];

    // Act
    const plan = buildStopPlan(fleet, { kind: 'label', label: 'ring' });

    // Assert
    should(plan.targets.map(target => target.depth)).deepEqual([1, 1]);
  });
});
