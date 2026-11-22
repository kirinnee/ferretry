/** Fake answers of the project file finder's three routes (&F6061 U5's wire), for the app suites and the visual scene. */
import {
  type ProjectFilesAnswer,
  ProjectFilesAnswerSchema,
  type ProjectFilesStatus,
  ProjectFilesStatusSchema,
  type ProjectIndexSummary,
  ProjectIndexSummarySchema,
} from '../../../../contract/index.ts';

export const FILES = 'GET /v1/projects/:id/files';
export const STATUS = 'GET /v1/projects/:id/files/status';
export const RESCAN = 'POST /v1/projects/:id/files/rescan';

/** `builtAt` is written as the ISO text the wire carries; the schema brands it. */
export const summaryOf = (
  overrides: Partial<Omit<ProjectIndexSummary, 'builtAt'>> & { readonly builtAt?: string } = {},
): ProjectIndexSummary =>
  ProjectIndexSummarySchema.parse({
    builtAt: '2026-08-01T10:00:00.000Z',
    indexed: 12_594,
    coverage: 'complete',
    skipped: [],
    biggestFolders: [],
    nestedWorktrees: [],
    ...overrides,
  });

/** An index that hit the 50,000 cap, with what the banner names. */
export const CAPPED = summaryOf({
  indexed: 50_000,
  coverage: 'partial',
  skipped: [
    { reason: 'truncated', count: 1_200 },
    { reason: 'denied', count: 41 },
  ],
  biggestFolders: [
    { folder: 'data', files: 31_200 },
    { folder: 'packages', files: 12_400 },
    { folder: 'docs', files: 3_100 },
  ],
  nestedWorktrees: ['.worktrees/f6061-u5', '.worktrees/f6061-u6', '.worktrees/f6061-u7'],
});

export const PATHS = [
  'README.md',
  'package.json',
  'packages/app/src/index.ts',
  'packages/plugins/projects/app/views/project-detail.tsx',
  'packages/plugins/projects/daemon/features/files/build.ts',
  'packages/plugins/projects/daemon/features/repos/scan.ts',
  'docs/standards/architecture/index.md',
];

const entry = (path: string) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) });

/** What the daemon answers: a case-folded substring over the path, the first `limit` rows, `total` before the cut. */
export const answerFor = (
  index: ProjectIndexSummary,
  query: string | undefined,
  limit: number,
  rebuilding = false,
  paths: readonly string[] = PATHS,
): ProjectFilesAnswer => {
  const found = paths.filter(path => query === undefined || path.toLowerCase().includes(query.toLowerCase()));
  return ProjectFilesAnswerSchema.parse({
    files: found.slice(0, limit).map(entry),
    total: found.length,
    rebuilding,
    index,
  });
};

export const statusOf = (index: ProjectIndexSummary | undefined, rebuilding = false): ProjectFilesStatus =>
  ProjectFilesStatusSchema.parse({ rebuilding, ...(index === undefined ? {} : { index }) });
