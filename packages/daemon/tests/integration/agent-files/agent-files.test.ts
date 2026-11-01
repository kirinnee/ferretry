import { afterEach, beforeEach, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeAgentFilesystem } from '../../../src/adapters/agent-files/index.ts';
import { AGENT_FILE_LIMITS, AgentFileError, AgentFiles } from '../../../src/lib/index.ts';

/**
 * THE FILE TOOLS' CONFINEMENT, AGAINST A REAL DISK. The properties here are the ones a fake cannot show:
 * that a symlink leading out of the session's folder is refused rather than followed, that nothing is
 * ever written through a link, and that a saved file never becomes executable.
 */

let root = '';
let folder = '';
let home = '';
let files: AgentFiles;
let attachments: Map<string, { filename: string; bytes: Uint8Array }>;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferretry-agent-files-'));
  folder = join(root, 'work');
  await mkdir(folder, { recursive: true });
  // The daemon's state home INSIDE the session folder: a session started in the person's home folder holds it.
  home = join(folder, '.fy');
  await mkdir(join(home, 'state'), { recursive: true });
  await writeFile(join(home, 'api-token'), 'fy_admin_token');
  await writeFile(join(home, 'state', 'secrets.key'), 'key');
  attachments = new Map();
  counter = 0;
  files = new AgentFiles({
    fs: new NodeAgentFilesystem(),
    folderOf: async sessionId => (sessionId === 's1' ? folder : undefined),
    readAttachment: async (_sessionId, id) => {
      const found = attachments.get(id);
      if (found === undefined) throw new Error('no such attachment');
      return found;
    },
    uploadDirectory: join(root, 'upload'),
    stateHomes: [home, join(home, 'state')],
    now: () => 1_000,
    token: () => {
      counter += 1;
      return `t${String(counter)}`;
    },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = async (work: Promise<unknown>): Promise<AgentFileError> => {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  should(error).be.instanceOf(AgentFileError);
  return error as AgentFileError;
};

const staged = async (content: string, name = 'data.csv') => {
  const path = join(root, 'stage', name);
  await mkdir(join(root, 'stage'), { recursive: true });
  await writeFile(path, content);
  return { path, name, size: Buffer.byteLength(content) };
};

const SAVE = { maxBytes: AGENT_FILE_LIMITS.downloadBytes };

describe('AgentFiles.prepareUpload — what an agent may hand a page', () => {
  it('should accept a file in the folder, by relative or absolute path, with its real size', async () => {
    await mkdir(join(folder, 'reports'));
    await writeFile(join(folder, 'reports', 'q3.pdf'), '12345');

    const relative = await files.prepareUpload('s1', ['reports/q3.pdf']);
    const absolute = await files.prepareUpload('s1', [join(folder, 'reports', 'q3.pdf')]);

    // Each upload hands the page its own private copy, so the two name the same file but not the same path.
    should(relative.files).match([{ name: 'q3.pdf', size: 5 }]);
    should(absolute.files).match([{ name: 'q3.pdf', size: 5 }]);
    should(await readFile(absolute.files[0]?.path ?? '', 'utf8')).equal('12345');
    should(await readFile(relative.files[0]?.path ?? '', 'utf8')).equal('12345');
  });

  it('should refuse "..", an absolute path outside, and a session with no folder', async () => {
    await writeFile(join(root, 'outside.txt'), 'x');

    should((await refusal(files.prepareUpload('s1', ['../outside.txt']))).code).equal('forbidden');
    should((await refusal(files.prepareUpload('s1', [join(root, 'outside.txt')]))).code).equal('forbidden');
    should((await refusal(files.prepareUpload('nobody', ['a.txt']))).code).equal('not_found');
  });

  it('should refuse a symlink that leads out of the folder, to a file or to a folder', async () => {
    await writeFile(join(root, 'outside.txt'), 'secret');
    await mkdir(join(root, 'elsewhere'));
    await writeFile(join(root, 'elsewhere', 'key.pem'), 'key');
    await symlink(join(root, 'outside.txt'), join(folder, 'link.txt'));
    await symlink(join(root, 'elsewhere'), join(folder, 'dir'));

    should((await refusal(files.prepareUpload('s1', ['link.txt']))).code).equal('forbidden');
    should((await refusal(files.prepareUpload('s1', ['dir/key.pem']))).code).equal('forbidden');
  });

  it('should follow a symlink that stays inside the folder', async () => {
    await writeFile(join(folder, 'real.txt'), 'abc');
    await symlink(join(folder, 'real.txt'), join(folder, 'alias.txt'));

    const prepared = await files.prepareUpload('s1', ['alias.txt']);

    should(prepared.files).match([{ size: 3 }]);
  });

  it('should refuse .git and the daemon’s scratch entries, directly or through a link', async () => {
    await mkdir(join(folder, '.git'));
    await writeFile(join(folder, '.git', 'config'), 'x');
    await writeFile(join(folder, 'events.jsonl'), 'x');
    await mkdir(join(folder, 'docs'));
    await symlink(join(folder, '.git', 'config'), join(folder, 'docs', 'gitconfig'));

    should((await refusal(files.prepareUpload('s1', ['.git/config']))).code).equal('forbidden');
    should((await refusal(files.prepareUpload('s1', ['events.jsonl']))).code).equal('forbidden');
    should((await refusal(files.prepareUpload('s1', ['docs/gitconfig']))).code).equal('forbidden');
  });

  it('should refuse a missing file, and a folder, in plain words', async () => {
    await mkdir(join(folder, 'sub'));

    should((await refusal(files.prepareUpload('s1', ['nope.txt']))).code).equal('not_found');
    should((await refusal(files.prepareUpload('s1', ['sub']))).message).containEql('not a file');
  });

  it('should hold one call to 200 MiB in all, and release what it placed when it refuses', async () => {
    const big = new Uint8Array(50 * 1024 * 1024);
    for (let index = 1; index <= 5; index += 1)
      attachments.set(`att_${String(index)}`, { filename: `big${String(index)}.bin`, bytes: big });

    const error = await refusal(
      files.prepareUpload(
        's1',
        [1, 2, 3, 4, 5].map(index => ({ attachment: `att_${String(index)}` })),
      ),
    );

    should(error.message).containEql('200 MiB');
    should(
      await stat(join(root, 'upload', '1000-t1')).then(
        () => true,
        () => false,
      ),
    ).be.false();
  });

  it('should place an attachment under the daemon’s own directory, privately, and remove it on release', async () => {
    attachments.set('att_one', { filename: '../../evil/cv.pdf', bytes: new Uint8Array([1, 2, 3]) });

    const prepared = await files.prepareUpload('s1', [{ attachment: 'att_one' }]);
    const placed = prepared.files[0];
    const mode = (await stat(placed?.path ?? '')).mode & 0o777;

    should(placed?.path.startsWith(join(root, 'upload'))).be.true();
    should(placed?.name).equal('cv.pdf');
    should(mode).equal(0o600);
    await prepared.release();
    should(
      await stat(placed?.path ?? '').then(
        () => true,
        () => false,
      ),
    ).be.false();
  });

  it('should refuse an attachment this session does not have', async () => {
    should((await refusal(files.prepareUpload('s1', [{ attachment: 'att_other' }]))).code).equal('not_found');
  });
});

describe('AgentFiles.prepareUpload — never a file in the daemon’s state home, on a real disk', () => {
  const rules = async (paths: readonly string[]) =>
    await Promise.all(paths.map(async path => (await refusal(files.prepareUpload('s1', [path]))).rule));

  it('should refuse the state home named directly, by "..", through a symlink, and through a chain of them', async () => {
    // Arrange
    await mkdir(join(folder, 'project'));
    await symlink(join(home, 'api-token'), join(folder, 'project', 'token'));
    await symlink(join(folder, 'project', 'token'), join(folder, 'project', 'hop2'));
    await symlink(join(folder, 'project', 'hop2'), join(folder, 'project', 'hop1'));
    await symlink(join(home, 'state'), join(folder, 'project', 'state'));

    // Act
    const refused = await rules([
      '.fy/api-token',
      join(home, 'state', 'secrets.key'),
      'project/token',
      'project/hop1',
      'project/state/secrets.key',
      '.fy',
    ]);
    const dotted = await refusal(files.prepareUpload('s1', ['project/../.fy/api-token']));

    // Assert
    should(refused).deepEqual(['state-home', 'state-home', 'state-home', 'state-home', 'state-home', 'state-home']);
    should(dotted.code).equal('forbidden');
    should(await readdir(join(root, 'upload')).catch(() => [])).deepEqual([]);
  });

  it('should refuse a hard link into the state home — and, since its other name cannot be told, any hard link', async () => {
    // Arrange
    await link(join(home, 'api-token'), join(folder, 'innocent.txt'));
    await writeFile(join(folder, 'mine.txt'), 'mine');
    await link(join(folder, 'mine.txt'), join(folder, 'mine-too.txt'));

    // Act
    const refused = await rules(['innocent.txt', 'mine-too.txt']);

    // Assert
    should(refused).deepEqual(['hard-link', 'hard-link']);
  });

  it('should fail closed when the real path cannot be found, and refuse a folder and a pipe', async () => {
    // Arrange
    await symlink(join(root, 'nowhere'), join(folder, 'dangling'));
    await symlink(join(folder, 'loop'), join(folder, 'loop'));
    await mkdir(join(folder, 'sub'));
    should(spawnSync('mkfifo', [join(folder, 'pipe')]).status).equal(0);

    // Act
    const codes = await Promise.all(
      ['dangling', 'loop', 'sub', 'pipe'].map(async path => (await refusal(files.prepareUpload('s1', [path]))).code),
    );

    // Assert
    should(codes).deepEqual(['not_found', 'not_found', 'bad_request', 'bad_request']);
  });

  it('should still upload an ordinary file, as a private copy the agent cannot change afterwards', async () => {
    // Arrange
    await writeFile(join(folder, 'report.txt'), 'quarterly');

    // Act
    const prepared = await files.prepareUpload('s1', ['report.txt']);
    await writeFile(join(folder, 'report.txt'), 'swapped after the check');
    const copy = prepared.files[0]?.path ?? '';

    // Assert
    should(prepared.files).match([{ name: 'report.txt', size: 9 }]);
    should(copy.startsWith(join(root, 'upload'))).be.true();
    should((await stat(copy)).mode & 0o777).equal(0o600);
    should(await readFile(copy, 'utf8')).equal('quarterly');
  });
});

describe('AgentFiles.save — where a download or a PDF may land', () => {
  it('should default to downloads/<sanitized name>, creating the folder, and never set +x', async () => {
    const source = await staged('a,b\n', '../../sneaky name.csv');
    await chmod(source.path, 0o755);

    const saved = await files.save('s1', source, SAVE);
    const info = await stat(join(folder, 'downloads', 'sneaky name.csv'));

    should(saved).match({ saved: 'downloads/sneaky name.csv', size: 4 });
    should(info.mode & 0o111).equal(0);
    should(await readFile(join(folder, 'downloads', 'sneaky name.csv'), 'utf8')).equal('a,b\n');
  });

  it('should save where saveAs says, inside the folder, and refuse outside, "..", .git and scratch entries', async () => {
    const source = await staged('x');

    const saved = await files.save('s1', source, { ...SAVE, saveAs: 'out/deep/file.bin' });

    should(saved.saved).equal('out/deep/file.bin');
    for (const saveAs of ['../escape.bin', join(root, 'escape.bin'), '.git/hooks/pre-commit', 'chat.jsonl'])
      should((await refusal(files.save('s1', source, { ...SAVE, saveAs }))).code).equal('forbidden');
    should(
      await stat(join(root, 'escape.bin')).then(
        () => true,
        () => false,
      ),
    ).be.false();
  });

  it('should refuse a folder that is a symlink out of the working folder, and write nothing through it', async () => {
    const source = await staged('x');
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(folder, 'downloads'));

    const error = await refusal(files.save('s1', source, SAVE));

    should(error.code).equal('forbidden');
    should(
      await stat(join(root, 'elsewhere', 'data.csv')).then(
        () => true,
        () => false,
      ),
    ).be.false();
  });

  it('should never write through a symlink at the destination, even with overwrite', async () => {
    const source = await staged('new');
    await writeFile(join(root, 'victim.txt'), 'precious');
    await symlink(join(root, 'victim.txt'), join(folder, 'target.txt'));

    const error = await refusal(files.save('s1', source, { ...SAVE, saveAs: 'target.txt', overwrite: true }));

    should(error.code).equal('forbidden');
    should(await readFile(join(root, 'victim.txt'), 'utf8')).equal('precious');
  });

  it('should refuse to replace an existing file unless asked, and replace it when asked', async () => {
    await mkdir(join(folder, 'downloads'));
    await writeFile(join(folder, 'downloads', 'data.csv'), 'old');
    const source = await staged('new content');

    const refused = await refusal(files.save('s1', source, SAVE));
    const replaced = await files.save('s1', source, { ...SAVE, overwrite: true });

    should(refused).match({ code: 'conflict' });
    should(refused.message).containEql('overwrite');
    should(replaced.size).equal(11);
    should(await readFile(join(folder, 'downloads', 'data.csv'), 'utf8')).equal('new content');
  });

  it('should refuse a destination that is a folder, or the working folder itself', async () => {
    const source = await staged('x');
    await mkdir(join(folder, 'taken'));

    should((await refusal(files.save('s1', source, { ...SAVE, saveAs: 'taken', overwrite: true }))).code).equal(
      'conflict',
    );
    should((await refusal(files.save('s1', source, { ...SAVE, saveAs: '.' }))).code).equal('bad_request');
  });

  it('should refuse a file over the cap and leave nothing behind', async () => {
    const source = await staged('0123456789');

    const error = await refusal(files.save('s1', source, { maxBytes: 5 }));

    should(error.message).containEql('size limit');
    should(
      await stat(join(folder, 'downloads')).then(
        () => true,
        () => false,
      ),
    ).be.false();
  });
});

describe('NodeAgentFilesystem.lstat', () => {
  it('should report a missing entry as nothing, but let any other failure through', async () => {
    const disk = new NodeAgentFilesystem();

    should(await disk.lstat(join(folder, 'nope'))).be.undefined();
    await disk.lstat(join(folder, 'x'.repeat(300))).then(
      () => should.fail(undefined, undefined, 'a name that long should not be looked up'),
      (error: unknown) => should(error).be.instanceOf(Error),
    );
  });
});

describe('NodeAgentFilesystem — what the upload guard reads', () => {
  it('should list a folder, list nothing where there is none, and let any other failure through', async () => {
    const disk = new NodeAgentFilesystem();
    await writeFile(join(folder, 'a.txt'), 'a');

    should(await disk.list(folder)).containEql('a.txt');
    should(await disk.list(join(folder, 'nope'))).deepEqual([]);
    await disk.list(join(folder, 'x'.repeat(300))).then(
      () => should.fail(undefined, undefined, 'a name that long should not be listed'),
      (error: unknown) => should(error).be.instanceOf(Error),
    );
  });

  it('should tell a file by its device and inode, and refuse to open a link at the last step', async () => {
    // Arrange
    const disk = new NodeAgentFilesystem();
    await writeFile(join(folder, 'a.txt'), 'abc');
    await link(join(folder, 'a.txt'), join(folder, 'b.txt'));
    await symlink(join(folder, 'a.txt'), join(folder, 'c.txt'));

    // Act
    const opened = await disk.openRead(join(folder, 'a.txt'));
    const named = await disk.identity(join(folder, 'b.txt'));
    const linked = await disk.identity(join(folder, 'c.txt'));
    const followed = await disk.openRead(join(folder, 'c.txt')).then(
      () => 'opened',
      () => 'refused',
    );
    await opened.close();

    // Assert
    should(opened.identity).match({ kind: 'file', links: 2, size: 3 });
    should(named?.inode).equal(opened.identity.inode);
    should(named?.device).equal(opened.identity.device);
    should(linked?.kind).equal('link');
    should(followed).equal('refused');
  });

  it('should copy from the open file into a new private one, never over an existing file, and stop at the cap', async () => {
    // Arrange
    const disk = new NodeAgentFilesystem();
    await writeFile(join(folder, 'big.bin'), new Uint8Array(200_000));
    await writeFile(join(folder, 'taken.bin'), 'x');
    const opened = await disk.openRead(join(folder, 'big.bin'));

    // Act
    const copied = await opened.copyTo(join(folder, 'copy.bin'), 1_000_000);
    const over = await opened.copyTo(join(folder, 'small.bin'), 100_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    const taken = await opened.copyTo(join(folder, 'taken.bin'), 1_000_000).then(
      () => undefined,
      (error: unknown) => error,
    );
    await opened.close();

    // Assert
    should(copied).equal(200_000);
    should((await stat(join(folder, 'copy.bin'))).mode & 0o777).equal(0o600);
    should(over).be.instanceOf(AgentFileError);
    should(taken).be.instanceOf(Error);
    should(await readFile(join(folder, 'taken.bin'), 'utf8')).equal('x');
  });
});
