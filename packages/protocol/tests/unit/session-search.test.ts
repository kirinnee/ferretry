import { describe, it } from 'bun:test';
import should from 'should';
import type { SessionFileIndexResponse, SessionSearchTask } from '../../src/lib/index.ts';
import * as sessionSearch from '../../src/lib/session-search.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const task = {
  id: 'F12',
  title: 'Land the Tasks pane performance fix',
  description: 'The board read fans out one detail request per row.',
  ask: { text: 'Make the current-session search fast on a phone.' },
  clarifications: [{ text: 'Relay round trips are the cost that matters.' }, { text: 'Ranking stays in the client.' }],
} satisfies SessionSearchTask;

const index = {
  v: 1,
  sessionId: 'msh6ugrm-1a24ff64',
  root: '/work/ferretry',
  files: [{ path: 'src/lib/session-search.ts', name: 'session-search.ts' }],
  coverage: 'complete',
  skipped: [{ reason: 'denied', count: 3 }],
} satisfies SessionFileIndexResponse;

const cases: SchemaCase[] = [
  { name: 'query', schema: sessionSearch.SessionSearchQuerySchema, value: 'perf' },
  { name: 'entry', schema: sessionSearch.SessionFileIndexEntrySchema, value: index.files[0] },
  { name: 'coverage', schema: sessionSearch.SessionFileIndexCoverageSchema, value: 'partial' },
  { name: 'reason', schema: sessionSearch.SessionFileIndexSkipReasonSchema, value: 'unreadable' },
  { name: 'skip', schema: sessionSearch.SessionFileIndexSkipSchema, value: { reason: 'truncated', count: 2 } },
  {
    name: 'index',
    schema: sessionSearch.SessionFileIndexSchema,
    value: { root: index.root, files: index.files, coverage: index.coverage, skipped: index.skipped },
  },
  { name: 'response', schema: sessionSearch.SessionFileIndexResponseSchema, value: index },
];

describe('the session search query', () => {
  it('should round-trip every public session-search schema', () => {
    // Arrange + Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(sessionSearch, cases);
  });

  it('should refuse a query longer than a person types or an empty one', () => {
    // Arrange
    const overLong = 'x'.repeat(sessionSearch.MAX_SESSION_SEARCH_QUERY_LENGTH + 1);

    // Act + Assert
    assertRejects([
      { name: 'too long', schema: sessionSearch.SessionSearchQuerySchema, value: overLong },
      { name: 'empty', schema: sessionSearch.SessionSearchQuerySchema, value: '' },
      { name: 'blank after trimming', schema: sessionSearch.SessionSearchQuerySchema, value: '   ' },
      { name: 'control character', schema: sessionSearch.SessionSearchQuerySchema, value: 'two\nlines' },
    ]);
  });

  it('should trim useful query text at the owning boundary', () => {
    // Arrange + Act
    const parsed = sessionSearch.SessionSearchQuerySchema.parse('  round trip  ');

    // Assert
    should(parsed).eql('round trip');
  });

  it('should fold case and surrounding whitespace into the comparable form', () => {
    // Arrange
    const raw = '  Tasks Pane  ';

    // Act
    const normalized = sessionSearch.normalizeSessionSearchQuery(raw);

    // Assert
    should(normalized).eql('tasks pane');
  });

  it('should match every task field the row is searched by', () => {
    // Arrange
    const haystack = sessionSearch.sessionSearchTaskHaystack(task);
    const terms = ['f12', 'performance', 'detail request', 'phone', 'Relay round trips', 'Ranking'];

    // Act
    const verdicts = terms.map(term => sessionSearch.matchesSessionSearchQuery(haystack, term));

    // Assert
    should(verdicts).eql([true, true, true, true, true, true]);
  });

  it('should never let one query bridge two task fields', () => {
    // Arrange
    const haystack = sessionSearch.sessionSearchTaskHaystack(task);

    // Act
    const bridged = sessionSearch.matchesSessionSearchQuery(haystack, 'F12 Land');

    // Assert
    should(bridged).be.false();
  });

  it('should match a file on its name and on its path', () => {
    // Arrange
    const haystack = sessionSearch.sessionSearchFileHaystack({
      path: 'src/lib/session-search.ts',
      name: 'session-search.ts',
    });

    // Act
    const verdicts = [
      sessionSearch.matchesSessionSearchQuery(haystack, 'SESSION-SEARCH.TS'),
      sessionSearch.matchesSessionSearchQuery(haystack, 'src/lib'),
      sessionSearch.matchesSessionSearchQuery(haystack, 'adapters'),
    ];

    // Assert
    should(verdicts).eql([true, true, false]);
  });

  it('should answer a blank query with nothing rather than with everything', () => {
    // Arrange
    const haystack = sessionSearch.sessionSearchTaskHaystack(task);

    // Act
    const verdicts = ['', '   ', 'x'.repeat(sessionSearch.MAX_SESSION_SEARCH_QUERY_LENGTH + 1), 'two\nlines'].map(
      query => sessionSearch.matchesSessionSearchQuery(haystack, query),
    );

    // Assert
    should(verdicts).eql([false, false, false, false]);
  });
});

describe('the session file index document', () => {
  it('should refuse a complete claim over a walk that could not finish', () => {
    // Arrange
    const hidden = { ...index, skipped: [{ reason: 'truncated', count: 9 }] };

    // Act
    const parsed = sessionSearch.SessionFileIndexResponseSchema.safeParse(hidden);

    // Assert
    should(parsed.success).be.false();
    should(parsed.error?.issues[0]?.path).eql(['coverage']);
  });

  it('should accept the same skips once the document admits it is partial', () => {
    // Arrange
    const honest = {
      ...index,
      coverage: 'partial' as const,
      skipped: [
        { reason: 'unreadable' as const, count: 1 },
        { reason: 'truncated' as const, count: 9 },
      ],
    };

    // Act
    const parsed = sessionSearch.SessionFileIndexResponseSchema.parse(honest);

    // Assert
    should(parsed.coverage).eql('partial');
    should(parsed.skipped).have.length(2);
  });

  it('should keep policy refusals from making a finished walk look partial', () => {
    // Arrange
    const gated = {
      ...index,
      skipped: [
        { reason: 'denied' as const, count: 3 },
        { reason: 'excluded' as const, count: 7 },
        { reason: 'unsupported' as const, count: 812 },
      ],
    };

    // Act
    const parsed = sessionSearch.SessionFileIndexResponseSchema.parse(gated);

    // Assert
    should(parsed.coverage).eql('complete');
  });

  it('should refuse a skip record that reports one reason twice or counts nothing', () => {
    // Arrange
    const doubled = {
      ...index,
      skipped: [
        { reason: 'denied', count: 1 },
        { reason: 'denied', count: 2 },
      ],
    };
    const empty = { ...index, skipped: [{ reason: 'denied', count: 0 }] };

    // Act
    const parsed = sessionSearch.SessionFileIndexResponseSchema.safeParse(doubled);

    // Assert
    should(parsed.error?.issues[0]?.path).eql(['skipped']);
    assertRejects([{ name: 'zero count', schema: sessionSearch.SessionFileIndexResponseSchema, value: empty }]);
  });

  it('should carry the same coherence rule on the domain document as on the wire one', () => {
    // Arrange
    const inner = { root: index.root, files: [], coverage: 'complete', skipped: [{ reason: 'unreadable', count: 1 }] };

    // Act
    const parsed = sessionSearch.SessionFileIndexSchema.safeParse(inner);

    // Assert
    should(parsed.success).be.false();
  });

  it('should refuse a partial claim that names no incomplete work', () => {
    // Arrange
    const unexplained = { ...index, coverage: 'partial', skipped: [{ reason: 'excluded', count: 1 }] };

    // Act
    const parsed = sessionSearch.SessionFileIndexResponseSchema.safeParse(unexplained);

    // Assert
    should(parsed.success).be.false();
    should(parsed.error?.issues[0]?.path).eql(['coverage']);
  });

  it('should refuse unsafe, inconsistent, or unreasonably large file rows', () => {
    // Arrange
    const rows = [
      { path: '/etc/passwd', name: 'passwd' },
      { path: '../outside', name: 'outside' },
      { path: 'src\\outside', name: 'outside' },
      { path: 'src//app.ts', name: 'app.ts' },
      { path: 'src/app.ts', name: 'wrong.ts' },
      { path: `src/${'x'.repeat(sessionSearch.MAX_SESSION_FILE_INDEX_PATH_LENGTH)}`, name: 'x' },
    ];

    // Act + Assert
    for (const row of rows) {
      should(sessionSearch.SessionFileIndexEntrySchema.safeParse(row).success).be.false();
    }
  });

  it('should refuse duplicate indexed paths', () => {
    // Arrange
    const duplicated = { ...index, files: [index.files[0], index.files[0]] };

    // Act
    const parsed = sessionSearch.SessionFileIndexResponseSchema.safeParse(duplicated);

    // Assert
    should(parsed.success).be.false();
    should(parsed.error?.issues[0]?.path).eql(['files']);
  });
});
