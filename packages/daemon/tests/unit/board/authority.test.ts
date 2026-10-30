import { describe, it } from 'bun:test';
import should from 'should';
import {
  type BoardCaller,
  type BoardOperation,
  type BoardStanding,
  effectiveAssignee,
  MAX_LINEAGE_DEPTH,
  mayDo,
  OPERATION_STANDINGS,
  refusalMessage,
  standingOf,
  ancestorsOf,
} from '../../../src/lib/board/index.ts';
import { FakeParents } from './support.ts';

const owned = { owner: 'lead', assignee: 'child' };

describe('a caller standing on a card', () => {
  it.each<{ caller: BoardCaller; ancestors: readonly string[]; expected: BoardStanding }>([
    { caller: { kind: 'owner' }, ancestors: [], expected: 'owner-human' },
    { caller: { kind: 'daemon' }, ancestors: [], expected: 'daemon' },
    { caller: { kind: 'ferret', sessionId: 'lead' }, ancestors: [], expected: 'owner' },
    { caller: { kind: 'ferret', sessionId: 'boss' }, ancestors: ['boss'], expected: 'ancestor' },
    { caller: { kind: 'ferret', sessionId: 'child' }, ancestors: ['boss'], expected: 'assignee' },
    { caller: { kind: 'ferret', sessionId: 'stranger' }, ancestors: ['boss'], expected: 'reader' },
  ])('should read $expected for that caller', ({ caller, ancestors, expected }) => {
    // Act
    const standing = standingOf(caller, owned, ancestors);

    // Assert
    should(standing).equal(expected);
  });

  it('should rank an ancestor above an assignee who is both', () => {
    // Act
    const standing = standingOf({ kind: 'ferret', sessionId: 'child' }, owned, ['child']);

    // Assert
    should(standing).equal('ancestor');
  });

  it('should read the owner as the assignee of a card with none', () => {
    // Act
    const standing = standingOf({ kind: 'ferret', sessionId: 'lead' }, { owner: 'lead', assignee: null }, []);

    // Assert
    should(effectiveAssignee({ owner: 'lead', assignee: null })).equal('lead');
    should(effectiveAssignee(owned)).equal('child');
    should(standing).equal('owner');
  });
});

describe('the authority matrix', () => {
  const allowed = (operation: BoardOperation): BoardStanding[] =>
    (['owner-human', 'owner', 'ancestor', 'assignee', 'daemon', 'reader'] as const).filter(standing =>
      mayDo(operation, standing),
    );

  it.each<{ operation: BoardOperation; expected: BoardStanding[] }>([
    { operation: 'move', expected: ['owner-human', 'owner', 'ancestor', 'assignee'] },
    { operation: 'note', expected: ['owner-human', 'owner', 'ancestor', 'assignee'] },
    { operation: 'block', expected: ['owner-human', 'owner', 'ancestor', 'assignee'] },
    { operation: 'file', expected: ['owner-human', 'owner', 'ancestor', 'assignee'] },
    { operation: 'depend', expected: ['owner-human', 'owner', 'ancestor', 'assignee'] },
    { operation: 'link', expected: ['owner-human', 'owner', 'ancestor', 'assignee', 'daemon'] },
    { operation: 'refile', expected: ['owner-human', 'owner', 'ancestor', 'assignee', 'daemon'] },
    { operation: 'drop', expected: ['owner-human', 'owner', 'ancestor'] },
    { operation: 'assign', expected: ['owner-human', 'owner', 'ancestor'] },
    { operation: 'order', expected: ['owner-human', 'owner', 'ancestor'] },
    { operation: 'reparent', expected: ['owner-human', 'owner', 'ancestor'] },
    { operation: 'replan', expected: ['owner-human', 'owner', 'ancestor'] },
    { operation: 'override', expected: ['owner-human'] },
    { operation: 'pass-gate', expected: ['owner-human'] },
    { operation: 'trigger', expected: ['daemon'] },
  ])('should let exactly $expected $operation', ({ operation, expected }) => {
    // Act
    const actual = allowed(operation);

    // Assert
    should(actual).eql(expected);
  });

  it('should never let a reader write anything', () => {
    // Act
    const writable = (Object.keys(OPERATION_STANDINGS) as BoardOperation[]).filter(operation =>
      mayDo(operation, 'reader'),
    );

    // Assert
    should(writable).eql([]);
  });
});

describe('a refusal message', () => {
  it('should name who may do it and the card owner alone when it has no other assignee', () => {
    // Act
    const message = refusalMessage('drop', { id: 'F3', owner: 'lead', assignee: null });

    // Assert
    should(message).equal(
      "only the owner, its owner ferret, the owner ferret's leads may drop &F3 (owner ferret lead)",
    );
  });

  it('should name the assignee too when someone else is doing it', () => {
    // Act
    const message = refusalMessage('move', { id: 'F3', ...owned });

    // Assert
    should(message).endWith('may move &F3 (owner ferret lead, assignee child)');
  });

  it('should treat an assignee that is the owner as no separate assignee', () => {
    // Act
    const message = refusalMessage('trigger', { id: 'B2', owner: 'lead', assignee: 'lead' });

    // Assert
    should(message).equal('only the daemon may trigger a move of &B2 (owner ferret lead)');
  });
});

describe('the lineage walk', () => {
  it('should list the ancestors nearest first', async () => {
    // Act
    const ancestors = await ancestorsOf('grandchild', new FakeParents({ grandchild: 'child', child: 'lead' }));

    // Assert
    should(ancestors).eql(['child', 'lead']);
  });

  it('should stop at a parent the daemon does not know', async () => {
    // Act
    const ancestors = await ancestorsOf('orphan', new FakeParents({}));

    // Assert
    should(ancestors).eql([]);
  });

  it('should stop at the first repeat of a loop', async () => {
    // Act
    const ancestors = await ancestorsOf('a', new FakeParents({ a: 'b', b: 'c', c: 'a' }));

    // Assert
    should(ancestors).eql(['b', 'c']);
  });

  it('should stop at the depth bound on an endless chain', async () => {
    // Arrange
    let calls = 0;
    const endless = {
      parentOf: async (sessionId: string) => {
        calls += 1;
        return `${sessionId}^`;
      },
    };

    // Act
    const ancestors = await ancestorsOf('s', endless);

    // Assert
    should(ancestors.length).equal(MAX_LINEAGE_DEPTH);
    should(calls).equal(MAX_LINEAGE_DEPTH);
  });
});
