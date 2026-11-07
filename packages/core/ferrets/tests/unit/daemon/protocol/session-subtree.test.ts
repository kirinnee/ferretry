import { describe, it } from 'bun:test';
import should from 'should';
import type { SessionView } from '../../../../daemon/lib/protocol/session.ts';
import {
  displayModel,
  lastLineLength,
  parentOf,
  SUBTREE_LAST_LINE_MAX,
  SubtreeRowSchema,
  sessionsById,
  subtreeDepths,
} from '../../../../daemon/lib/protocol/session-subtree.ts';

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

describe('SubtreeRowSchema last line', () => {
  const row = (text: string) => ({
    id: 's',
    callsign: 'c',
    depth: 1,
    model: 'm',
    state: 'running',
    status: 'thinking',
    last: { at: '2026-11-03T12:00:00.000Z', source: 'note', text },
  });

  it('should count characters, not UTF-16 units, so a full line with an emoji in it is valid', () => {
    // Arrange: 99 letters + one emoji = 100 characters, 101 UTF-16 units
    const text = `${'a'.repeat(SUBTREE_LAST_LINE_MAX - 1)}🚀`;

    // Act / Assert
    should(text.length).equal(SUBTREE_LAST_LINE_MAX + 1);
    should(lastLineLength(text)).equal(SUBTREE_LAST_LINE_MAX);
    should(SubtreeRowSchema.safeParse(row(text)).success).be.true();
  });

  it('should refuse one character over the limit and an empty line', () => {
    should(SubtreeRowSchema.safeParse(row('a'.repeat(SUBTREE_LAST_LINE_MAX + 1))).success).be.false();
    should(SubtreeRowSchema.safeParse(row('')).success).be.false();
  });
});
