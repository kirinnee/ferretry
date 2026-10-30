import { describe, it } from 'bun:test';
import should from 'should';
import {
  BoardImportProblemSchema,
  BoardImportRequestSchema,
  BoardImportSummarySchema,
} from '../../src/lib/board-import.ts';

const summary = {
  dryRun: false,
  skipped: false,
  sessions: 2,
  imported: 3,
  alreadyImported: 1,
  proposedProjects: ['unfiled'],
  linkedAsks: 2,
  untriagedCards: 1,
  problems: [{ sessionId: 's1', taskId: null, detail: 'tasks.json could not be read' }],
  complete: true,
};

describe('the board import request', () => {
  it.each([{}, { dryRun: true }, { dryRun: false }])('should accept %o', value => {
    should(BoardImportRequestSchema.safeParse(value).success).equal(true);
  });

  it.each([{ dryRun: 'yes' }, { dryRun: true, extra: 1 }])('should refuse %o', value => {
    should(BoardImportRequestSchema.safeParse(value).success).equal(false);
  });
});

describe('the board import problem', () => {
  it('should allow a problem with no session or task, but not an empty detail', () => {
    should(BoardImportProblemSchema.safeParse({ sessionId: null, taskId: null, detail: 'x' }).success).equal(true);
    should(BoardImportProblemSchema.safeParse({ sessionId: null, taskId: null, detail: '' }).success).equal(false);
    should(BoardImportProblemSchema.safeParse({ sessionId: '', taskId: null, detail: 'x' }).success).equal(false);
  });
});

describe('the board import summary', () => {
  it('should accept a full summary', () => {
    should(BoardImportSummarySchema.parse(summary)).eql(summary);
  });

  it.each([
    { imported: -1 },
    { imported: 1.5 },
    { proposedProjects: ['not-a-project'] },
    { complete: 'yes' },
    { extra: true },
  ])('should refuse a summary with %o', override => {
    should(BoardImportSummarySchema.safeParse({ ...summary, ...override }).success).equal(false);
  });

  it('should refuse a summary missing a field', () => {
    const { skipped: _skipped, ...rest } = summary;
    should(BoardImportSummarySchema.safeParse(rest).success).equal(false);
  });
});
