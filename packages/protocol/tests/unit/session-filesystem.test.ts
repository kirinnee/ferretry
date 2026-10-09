import { describe, it } from 'bun:test';
import should from 'should';
import * as fs from '../../src/lib/session-filesystem.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const entry = { name: 'README.md', type: 'file', size: 12, mtime: '2026-10-09T00:00:00.000Z' } as const;
const refusedEntry = { name: '.env', type: 'file', denied: true, ignored: true, escapes: false } as const;
const listing = { root: '/work/repo', path: '', entries: [entry, refusedEntry, { name: 'src', type: 'dir' }] };
const file = { path: 'README.md', size: 12, content: '# hi', binary: false, rev: 'head' } as const;
const refusedFile = { path: '.env', size: 4, denied: true, reason: 'denylist', tooLarge: false } as const;
const change = { path: 'README.md', status: ' M', additions: 1, deletions: 0 };
const changes = { repo: true, branch: 'main', changes: [change, { path: 'b.ts', status: 'R ', from: 'a.ts' }] };

describe('session filesystem schemas', () => {
  it('should round-trip every public session filesystem schema', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'entry type', schema: fs.SessionFsEntryTypeSchema, value: 'symlink' },
      { name: 'entry', schema: fs.SessionFsEntrySchema, value: entry },
      { name: 'listing', schema: fs.SessionFsListingSchema, value: listing },
      { name: 'refusal reason', schema: fs.SessionFsRefusalReasonSchema, value: 'escapes' },
      { name: 'file', schema: fs.SessionFsFileSchema, value: file },
      { name: 'refused file', schema: fs.SessionFsFileSchema, value: refusedFile },
      { name: 'change', schema: fs.SessionGitChangeSchema, value: change },
      { name: 'changes', schema: fs.SessionFsChangesSchema, value: changes },
      { name: 'not a repository', schema: fs.SessionFsChangesSchema, value: { repo: false, changes: [] } },
    ];

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(fs, cases);
  });

  it('should refuse the bodies a cast used to accept', () => {
    // Arrange: each of these reached the file reference proof or a file render unchecked before.
    const cases: SchemaCase[] = [
      { name: 'listing without entries', schema: fs.SessionFsListingSchema, value: { root: '/r', path: '' } },
      { name: 'entry of unknown type', schema: fs.SessionFsEntrySchema, value: { name: 'x', type: 'socket' } },
      { name: 'entry with no name', schema: fs.SessionFsEntrySchema, value: { name: '', type: 'file' } },
      { name: 'denied as text', schema: fs.SessionFsEntrySchema, value: { name: 'x', type: 'file', denied: 'yes' } },
      { name: 'file without size', schema: fs.SessionFsFileSchema, value: { path: 'a' } },
      { name: 'unknown revision', schema: fs.SessionFsFileSchema, value: { path: 'a', size: 1, rev: 'main' } },
      { name: 'changes without repo flag', schema: fs.SessionFsChangesSchema, value: { changes: [] } },
      {
        name: 'negative additions',
        schema: fs.SessionGitChangeSchema,
        value: { path: 'a', status: ' M', additions: -1 },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should drop a field a newer daemon adds rather than refuse the listing', () => {
    // Act
    const parsed = fs.SessionFsListingSchema.parse({ ...listing, cursor: 'next' });

    // Assert
    should(parsed).deepEqual(listing);
  });
});
