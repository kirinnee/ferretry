import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_WORK_SEARCH_LIMIT,
  WorkHitSchema,
  WorkRelatedRequestSchema,
  WorkRelatedResponseSchema,
  WorkSearchQuerySchema,
} from '../../src/lib/work-search.ts';

const TASK_HIT = {
  kind: 'task',
  id: 'F303',
  projectId: 'unfiled',
  sessionId: 'lead',
  title: 'Search cards',
  state: 'open',
  standing: 'In progress',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'summary', line: 'one search' },
  score: 3,
} as const;

describe('the work search contract', () => {
  it('should fill a query with its defaults: everything, twenty hits', () => {
    // Act / Assert
    should(WorkSearchQuerySchema.parse({ q: '  relay  ' })).eql({ q: 'relay', open: false, limit: 20 });
  });

  it.each([
    ['blank words', { q: '   ' }],
    ['too many hits', { q: 'x', limit: MAX_WORK_SEARCH_LIMIT + 1 }],
    ['a kind that is not work', { q: 'x', kind: 'session' }],
    ['a field it does not know', { q: 'x', session: 'lead' }],
  ])('should refuse %s', (_, value) => {
    // Assert
    should(WorkSearchQuerySchema.safeParse(value).success).be.false();
  });

  it('should require an agenda hit to name the session its id belongs to', () => {
    // Arrange
    const { projectId: _, ...rest } = TASK_HIT;
    const agenda = { ...rest, kind: 'agenda', id: 'A3' };

    // Act / Assert
    should(WorkHitSchema.safeParse(agenda).success).be.true();
    should(WorkHitSchema.safeParse({ ...agenda, sessionId: null }).success).be.false();
    should(WorkHitSchema.safeParse(TASK_HIT).success).be.true();
    should(WorkHitSchema.safeParse({ ...TASK_HIT, id: 'A3' }).success).be.false();
  });

  it('should read a related check and its answer', () => {
    // Act / Assert
    should(WorkRelatedRequestSchema.parse({ kind: 'task', title: ' Search cards ' })).eql({
      kind: 'task',
      title: 'Search cards',
    });
    should(WorkRelatedResponseSchema.safeParse({ matches: [{ strength: 'strong', hit: TASK_HIT }] }).success).be.true();
    should(WorkRelatedResponseSchema.safeParse({ matches: [{ strength: 'maybe', hit: TASK_HIT }] }).success).be.false();
  });
});
