import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
let files: AgentFiles;
let attachments: Map<string, { filename: string; bytes: Uint8Array }>;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferretry-agent-files-'));
  folder = join(root, 'work');
  await mkdir(folder, { recursive: true });
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

    should(relative.files).match([{ name: 'q3.pdf', size: 5 }]);
    should(absolute.files[0]?.path).equal(relative.files[0]?.path);
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
      await stat(join(root, 'upload', 't1')).then(
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
