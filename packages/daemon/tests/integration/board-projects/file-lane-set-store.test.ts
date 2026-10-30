import { describe, it } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LANE_TEMPLATES, type LaneSet } from '@ferretry/protocol';
import should from 'should';
import { FileLaneSetStore } from '../../../src/adapters/board-projects/file-lane-set-store.ts';
import { TaskStateUnavailableError } from '../../../src/lib/tasks/task-error.ts';
import { withTempRoot } from '../tasks/fixtures.ts';

const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10' as LaneSet['projectId'];

const proposal = (version: number): LaneSet => ({
  projectId: PROJECT,
  version,
  confirmedBy: null,
  proposedBy: 'denisha',
  ...LANE_TEMPLATES.pr,
});

describe('the lane-set store', () => {
  it('should read no lanes for a project that has none', async () => {
    await withTempRoot(async root => {
      should(await new FileLaneSetStore(join(root, 'lanes')).read(PROJECT)).equal(null);
    });
  });

  it('should write a decided set atomically and read it back', async () => {
    await withTempRoot(async root => {
      const store = new FileLaneSetStore(join(root, 'lanes'));
      const result = await store.transact(PROJECT, current => ({
        next: proposal((current?.version ?? 0) + 1),
        result: 'ok',
      }));
      should(result).equal('ok');
      should(await store.read(PROJECT)).eql(proposal(1));
      should(await readdir(join(root, 'lanes'))).eql([`${PROJECT}.json`]);
    });
  });

  it('should keep the stored set when the decision writes nothing', async () => {
    await withTempRoot(async root => {
      const store = new FileLaneSetStore(join(root, 'lanes'));
      await store.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));
      const result = await store.transact(PROJECT, current => ({ result: current?.version }));
      should(result).equal(1);
      should(await store.read(PROJECT)).eql(proposal(1));
    });
  });

  it('should let only one of two racing edits win a version', async () => {
    await withTempRoot(async root => {
      const store = new FileLaneSetStore(join(root, 'lanes'));
      await store.transact(PROJECT, () => ({ next: proposal(1), result: undefined }));
      const bump = async () =>
        await store.transact(PROJECT, current => ({
          next: proposal((current?.version ?? 0) + 1),
          result: (current?.version ?? 0) + 1,
        }));
      should((await Promise.all([bump(), bump()])).sort()).eql([2, 3]);
    });
  });

  it('should refuse a document that is not JSON and leave it untouched', async () => {
    await withTempRoot(async root => {
      const directory = join(root, 'lanes');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${PROJECT}.json`), '{ not json');
      const store = new FileLaneSetStore(directory);
      await store.read(PROJECT).then(
        () => should.fail('expected a refusal', 'a refusal'),
        (error: unknown) => should(error).be.instanceof(TaskStateUnavailableError),
      );
      await store
        .transact(PROJECT, () => ({ next: proposal(1), result: undefined }))
        .then(
          () => should.fail('expected a refusal', 'a refusal'),
          (error: unknown) => should(error).be.instanceof(TaskStateUnavailableError),
        );
      should(await readFile(join(directory, `${PROJECT}.json`), 'utf8')).equal('{ not json');
    });
  });

  it('should refuse a document that parses but is not a lane set', async () => {
    await withTempRoot(async root => {
      const directory = join(root, 'lanes');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${PROJECT}.json`), JSON.stringify({ projectId: PROJECT, version: 0 }));
      await new FileLaneSetStore(directory).read(PROJECT).then(
        () => should.fail('expected a refusal', 'a refusal'),
        (error: unknown) => should(error).be.instanceof(TaskStateUnavailableError),
      );
    });
  });
});
