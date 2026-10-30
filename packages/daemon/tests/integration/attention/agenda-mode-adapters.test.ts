import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaMigrationMarker } from '../../../src/adapters/attention/file-agenda-migration-marker.ts';

/** The one-time agenda-mode migration's record, as it is kept on disk. */

const homes = new Set<string>();

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
  homes.add(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of homes) await rm(directory, { recursive: true, force: true });
  homes.clear();
});

describe('FileAgendaMigrationMarker', () => {
  it('should be unrecorded until recorded, then say it ran, in an owner-only document', async () => {
    // Arrange
    const root = await home();
    const file = join(root, 'nested', 'agenda-mode-migration.json');
    const marker = new FileAgendaMigrationMarker(file);

    // Act
    const before = await marker.ran();
    await marker.record('2026-10-23T10:00:00.000Z', ['session-1']);
    const after = await marker.ran();
    const document = JSON.parse(await readFile(file, 'utf8')) as unknown;

    // Assert
    should(before).be.false();
    should(after).be.true();
    should(document).deepEqual({ v: 1, ranAt: '2026-10-23T10:00:00.000Z', switchedOn: ['session-1'] });
  });

  it('should refuse to guess when the record cannot be read, rather than run the migration again', async () => {
    // Arrange: a directory where the document belongs reads as an error that is not "missing".
    const root = await home();
    const marker = new FileAgendaMigrationMarker(root);

    // Act + Assert
    await should(marker.ran()).be.rejectedWith({ code: 'EISDIR' });
  });
});
