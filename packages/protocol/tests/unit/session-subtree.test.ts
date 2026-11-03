import { describe, it } from 'bun:test';
import should from 'should';
import type { SessionView } from '../../src/lib/session.ts';
import { displayModel, parentOf, sessionsById, subtreeDepths } from '../../src/lib/session-subtree.ts';

const node = (id: string, parent?: string): SessionView =>
  ({ config: { id, ...(parent === undefined ? {} : { parent }) }, state: {} }) as unknown as SessionView;

describe('subtreeDepths', () => {
  it('should walk breadth-first from the root, the root at depth 0', () => {
    const byId = sessionsById([node('r'), node('a', 'r'), node('b', 'r'), node('c', 'a'), node('x'), node('y', 'x')]);

    should([...subtreeDepths(byId, 'r')]).deepEqual([
      ['r', 0],
      ['a', 1],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('should terminate on a parent cycle', () => {
    const byId = sessionsById([node('a', 'b'), node('b', 'a')]);

    should([...subtreeDepths(byId, 'a')]).deepEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('should treat a blank parent as none', () => {
    should(parentOf(node('a', '  '))).be.undefined();
    should(parentOf(node('a', ' r '))).equal('r');
  });
});

describe('displayModel', () => {
  it('should prefer the observed model, then the configured one, then the hint', () => {
    should(displayModel({ model: 'm', modelHint: 'h' }, { observedModel: 'o' })).equal('o');
    should(displayModel({ model: 'm', modelHint: 'h' }, {})).equal('m');
    should(displayModel({ modelHint: 'h' }, {})).equal('h');
    should(displayModel({ modelHint: ' ' }, {})).equal('default');
  });
});
