import { describe, expect, it } from 'bun:test';
import {
  absolutePath,
  coverageBanner,
  emptyResultSentence,
  foldersLine,
  matchCountLine,
  searchText,
  seedQuery,
  skippedLine,
  splitPath,
} from '../../../app/features/file-finder/finder-model.ts';
import { type ProjectIndexSummary, ProjectIndexSummarySchema } from '../../../contract/index.ts';

const summary = (overrides: Partial<ProjectIndexSummary> = {}): ProjectIndexSummary =>
  ProjectIndexSummarySchema.parse({
    builtAt: '2026-08-01T10:00:00.000Z',
    indexed: 12_594,
    coverage: 'complete',
    skipped: [],
    biggestFolders: [],
    nestedWorktrees: [],
    ...overrides,
  });

const AT_CAP = summary({
  indexed: 50_000,
  coverage: 'partial',
  skipped: [
    { reason: 'truncated', count: 1_200 },
    { reason: 'denied', count: 41 },
  ],
  biggestFolders: [
    { folder: 'data', files: 31_200 },
    { folder: 'packages', files: 12_400 },
  ],
  nestedWorktrees: ['.worktrees/a', '.worktrees/b', '.worktrees/c'],
});

describe('coverageBanner', () => {
  it('says nothing about a complete index that skipped nothing', () => {
    expect(coverageBanner(summary())).toBeNull();
  });

  it('at the cap says how many were kept, that the rest were not looked at, where, and what was skipped', () => {
    const banner = coverageBanner(AT_CAP);
    expect(banner?.kind).toBe('cap');
    expect(banner?.headline).toBe('Showing 50,000 of more than 50,000 files — the rest were not looked at.');
    expect(foldersLine(banner?.folders ?? [])).toBe('Most files: data/ (31,200), packages/ (12,400).');
    expect(banner?.skipped).toBe('Skipped: 3 nested worktrees, 41 secret-looking names.');
    expect(banner?.tip).toBe('Tip: add big generated folders to .gitignore.');
  });

  it('a partial index with no bound that bit says folders could not be read, never "complete"', () => {
    const banner = coverageBanner(
      summary({ coverage: 'partial', skipped: [{ reason: 'unreadable', count: 2 }], indexed: 900 }),
    );
    expect(banner?.kind).toBe('partial');
    expect(banner?.headline).toBe('Some folders could not be read, so this list may be missing files.');
    expect(banner?.skipped).toBe('Skipped: 2 folders that could not be read.');
    expect(banner?.tip).toBeNull();
  });

  it('a complete index that left some out mentions only what was skipped', () => {
    const banner = coverageBanner(summary({ skipped: [{ reason: 'denied', count: 1 }] }));
    expect(banner).toEqual({
      kind: 'notes',
      headline: null,
      folders: [],
      skipped: 'Skipped: 1 secret-looking name.',
      tip: null,
    });
  });
});

describe('skippedLine', () => {
  it('counts a single worktree in the singular and says "at least" when the daemon named only as many as it keeps', () => {
    expect(skippedLine(summary({ nestedWorktrees: ['w'] }))).toBe('Skipped: 1 nested worktree.');
    const many = Array.from({ length: 50 }, (_, index) => `w${String(index)}`);
    expect(skippedLine(summary({ nestedWorktrees: many }))).toBe('Skipped: at least 50 nested worktrees.');
  });

  it('is absent when nothing deliberate was left out (links and deleted files are not news)', () => {
    expect(skippedLine(summary({ skipped: [{ reason: 'unsupported', count: 9 }] }))).toBeNull();
  });
});

describe('emptyResultSentence', () => {
  it('over a complete index may say there is no match', () => {
    expect(emptyResultSentence('zzz', summary())).toBe('No file in this project matches “zzz”.');
    expect(emptyResultSentence('', summary({ indexed: 0 }))).toBe('This project has no files to list.');
  });

  it('over a partial index never says there is nothing: the file may exist beyond what was looked at', () => {
    const text = emptyResultSentence('zzz', AT_CAP);
    expect(text).toContain('No match for “zzz” among the 50,000 files that were looked at');
    expect(text).toContain('the file may exist beyond them');
    expect(text).not.toContain('No file in this project');
    expect(emptyResultSentence('', AT_CAP)).toContain('This index is partial');
  });
});

describe('small pieces', () => {
  it('matchCountLine is absent when every match is on screen', () => {
    expect(matchCountLine(3, 3)).toBeNull();
    expect(matchCountLine(50, 1_312)).toBe('Showing 50 of 1,312 matches.');
  });

  it('splitPath keeps the trailing slash on the folder so the halves rejoin to the path', () => {
    expect(splitPath('packages/app/index.ts')).toEqual({ folder: 'packages/app/', name: 'index.ts' });
    expect(splitPath('README.md')).toEqual({ folder: '', name: 'README.md' });
  });

  it('absolutePath joins the project folder and the relative path once', () => {
    expect(absolutePath('/work/ferretry/', 'src/a.ts')).toBe('/work/ferretry/src/a.ts');
    expect(absolutePath('/work/ferretry', 'a.ts')).toBe('/work/ferretry/a.ts');
  });

  it('searchText drops control characters, trims and bounds to what the daemon takes', () => {
    expect(searchText('  foo\nbar\u0007 ')).toBe('foo bar');
    expect(searchText('x'.repeat(500))).toHaveLength(200);
    expect(searchText('   ')).toBe('');
  });

  it('seedQuery reads ?find= and nothing else', () => {
    expect(seedQuery('?find=src%2Fa.ts&x=1')).toBe('src/a.ts');
    expect(seedQuery('?x=1')).toBe('');
    expect(seedQuery('')).toBe('');
  });
});
