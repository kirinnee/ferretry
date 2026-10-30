import { describe, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { FileBoardImportMarker, FileLegacyTaskSource } from '../../../src/adapters/board-import/index.ts';
import { GitProjectFacts } from '../../../src/adapters/board-projects/git-project-facts.ts';
import { serializeTaskSnapshot } from '../../../src/lib/tasks/task-snapshot.ts';
import { withTempRoot } from '../tasks/fixtures.ts';
import { snapshotOf, task } from '../../unit/tasks/fixtures.ts';

const SUMMARY = {
  dryRun: false,
  skipped: false,
  sessions: 1,
  imported: 2,
  alreadyImported: 0,
  proposedProjects: [],
  linkedAsks: 1,
  untriagedCards: 0,
  problems: [{ sessionId: 's1', taskId: 'F9', detail: 'bad' }],
  complete: true,
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

describe('FileBoardImportMarker', () => {
  it('should not have run before anything is recorded', async () => {
    await withTempRoot(async root => {
      should(await new FileBoardImportMarker(join(root, 'home', 'board-import.json')).ran()).equal(false);
    });
  });

  it('should record a run atomically, creating the directory, and then report it ran', async () => {
    await withTempRoot(async root => {
      const file = join(root, 'home', 'board-import.json');
      const marker = new FileBoardImportMarker(file);
      await marker.record('2026-10-30T10:00:00.000Z', SUMMARY);
      should(await marker.ran()).equal(true);
      const body = JSON.parse(await readFile(file, 'utf8'));
      should(body.v).equal(1);
      should(body.ranAt).equal('2026-10-30T10:00:00.000Z');
      should(body.imported).equal(2);
      should(body.problems).eql(SUMMARY.problems);
      should(await readdir(join(root, 'home'))).eql(['board-import.json']);
    });
  });

  it('should surface a read failure other than "missing" instead of calling it not-run', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'board-import.json'));
      await new FileBoardImportMarker(join(root, 'board-import.json')).ran().then(
        () => should.fail(undefined, undefined, 'expected a throw'),
        error => should((error as NodeJS.ErrnoException).code).equal('EISDIR'),
      );
    });
  });
});

describe('FileLegacyTaskSource', () => {
  const source = (root: string, ids: readonly string[]) =>
    new FileLegacyTaskSource(
      () => ids,
      id => join(root, id, 'tasks.json'),
    );

  it('should read each session file and leave out sessions with no or empty files', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'a'));
      await mkdir(join(root, 'empty'));
      await writeFile(join(root, 'a', 'tasks.json'), serializeTaskSnapshot(snapshotOf(task())));
      await writeFile(join(root, 'empty', 'tasks.json'), serializeTaskSnapshot(snapshotOf()));
      const found = await source(root, ['a', 'empty', 'missing']).read();
      should(found.map(file => file.sessionId)).eql(['a']);
      should(found[0]?.entries).length(1);
      should(found[0]?.fatal).equal(false);
    });
  });

  it('should report a file that is not JSON as fatal with an issue', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'bad'));
      await writeFile(join(root, 'bad', 'tasks.json'), '{not json');
      const [file] = await source(root, ['bad']).read();
      should(file?.fatal).equal(true);
      should(file?.entries).length(0);
    });
  });

  it('should report an unreadable file as fatal without throwing', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'locked'));
      await mkdir(join(root, 'locked', 'tasks.json'));
      const [file] = await source(root, ['locked']).read();
      should(file?.fatal).equal(true);
      should(file?.issues[0]?.scope).equal('snapshot');
    });
  });

  it('should leave the old file exactly as it was', async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'a'));
      const text = serializeTaskSnapshot(snapshotOf(task()));
      await writeFile(join(root, 'a', 'tasks.json'), text);
      await source(root, ['a']).read();
      should(await readFile(join(root, 'a', 'tasks.json'), 'utf8')).equal(text);
    });
  });
});

describe('GitProjectFacts', () => {
  it('should say no repository for a plain folder', async () => {
    await withTempRoot(async root => {
      should(await new GitProjectFacts().inspect(root)).eql({ hasRepository: false, hasReleaseTags: false });
    });
  });

  it('should find a repository without release tags, then with one', async () => {
    await withTempRoot(async root => {
      await git(root, 'init', '--quiet');
      await git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'root');
      await git(root, 'tag', 'nightly');
      should(await new GitProjectFacts().inspect(root)).eql({ hasRepository: true, hasReleaseTags: false });
      await git(root, 'tag', 'v1.0.0');
      should(await new GitProjectFacts().inspect(root)).eql({ hasRepository: true, hasReleaseTags: true });
    });
  });

  it('should say no release tags when git cannot be started for the tag listing', async () => {
    await withTempRoot(async root => {
      const probe = { commonDirectory: async () => '/somewhere/.git' };
      should(await new GitProjectFacts(join(root, 'no-such-git'), probe).inspect(root)).eql({
        hasRepository: true,
        hasReleaseTags: false,
      });
    });
  });
});
