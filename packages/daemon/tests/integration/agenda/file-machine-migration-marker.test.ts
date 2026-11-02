import { describe, it } from 'bun:test';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileMachineMigrationMarker } from '../../../src/adapters/agenda/file-machine-migration-marker.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

describe('FileMachineMigrationMarker', () => {
  it('should not have run before anything is recorded', async () => {
    await withTempRoot(async root => {
      should(await new FileMachineMigrationMarker(join(root, 'home', 'machine-notices.json')).ran()).equal(false);
    });
  });

  it('should record a run atomically, with the items it closed, creating the directory, and then report it ran', async () => {
    await withTempRoot(async root => {
      const file = join(root, 'home', 'machine-notices.json');
      const marker = new FileMachineMigrationMarker(file);
      await marker.record('2026-11-02T10:00:00.000Z', ['dyani !A1']);
      should(await marker.ran()).equal(true);
      should(JSON.parse(await readFile(file, 'utf8'))).eql({
        v: 1,
        ranAt: '2026-11-02T10:00:00.000Z',
        closed: ['dyani !A1'],
      });
      should(await readdir(join(root, 'home'))).eql(['machine-notices.json']);
    });
  });

  it('should surface a read failure other than "missing" instead of calling it not-run', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'machine-notices.json'));
      await new FileMachineMigrationMarker(join(root, 'machine-notices.json')).ran().then(
        () => should.fail(undefined, undefined, 'expected a throw'),
        error => should((error as NodeJS.ErrnoException).code).equal('EISDIR'),
      );
    });
  });
});
