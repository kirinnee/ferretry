import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { AGENT_FILE_LIMITS, AgentFileError, AgentFiles, type AgentFilesystem } from '../../../src/lib/index.ts';

type Entry =
  | { readonly kind: 'file'; readonly size: number }
  | { readonly kind: 'directory' }
  | { readonly kind: 'link'; readonly target: string };

/** An in-memory disk: files, folders and links, resolved the way a real one resolves them. */
class FakeDisk implements AgentFilesystem {
  readonly entries = new Map<string, Entry>([['/', { kind: 'directory' }]]);
  readonly removed: string[] = [];
  readonly modes: Array<readonly [string, number]> = [];
  failRemove = false;
  afterMkdirp: ((path: string) => void) | undefined;

  dir(path: string): void {
    this.entries.set(path, { kind: 'directory' });
  }
  file(path: string, size: number): void {
    this.entries.set(path, { kind: 'file', size });
  }
  link(path: string, target: string): void {
    this.entries.set(path, { kind: 'link', target });
  }

  async realpath(path: string): Promise<string> {
    let current = '/';
    const pending = path.split('/').filter(segment => segment !== '');
    let hops = 0;
    while (pending.length > 0) {
      const next = join(current, pending.shift() as string);
      const entry = this.entries.get(next);
      if (entry === undefined) throw new Error(`ENOENT ${next}`);
      if (entry.kind === 'link') {
        hops += 1;
        if (hops > 20) throw new Error('ELOOP');
        current = '/';
        pending.unshift(...entry.target.split('/').filter(segment => segment !== ''));
      } else current = next;
    }
    return current;
  }
  async lstat(path: string) {
    const entry = this.entries.get(path);
    if (entry === undefined) return undefined;
    return { kind: entry.kind, size: entry.kind === 'file' ? entry.size : 0 };
  }
  async fileSize(path: string): Promise<number | undefined> {
    const entry = this.entries.get(await this.realpath(path));
    return entry?.kind === 'file' ? entry.size : undefined;
  }
  async mkdirp(path: string, mode: number): Promise<void> {
    let current = '/';
    for (const segment of path.split('/').filter(part => part !== '')) {
      current = join(current, segment);
      if (!this.entries.has(current)) this.dir(current);
    }
    this.modes.push([path, mode]);
    this.afterMkdirp?.(path);
  }
  async writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    this.file(path, bytes.byteLength);
    this.modes.push([path, mode]);
  }
  async copyNew(from: string, to: string, maxBytes: number): Promise<number> {
    const source = this.entries.get(await this.realpath(from));
    if (source?.kind !== 'file') throw new Error('not a file');
    if (source.size > maxBytes) throw new AgentFileError('bad_request', 'that file grew past the save size limit');
    if (this.entries.has(to)) throw new Error('EEXIST');
    this.file(to, source.size);
    return source.size;
  }
  async remove(path: string): Promise<void> {
    this.removed.push(path);
    if (this.failRemove) throw new Error('EBUSY');
    for (const key of [...this.entries.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
  }
}

interface World {
  readonly disk: FakeDisk;
  readonly files: AgentFiles;
  readonly attachments: Map<string, { filename: string; bytes: Uint8Array }>;
}

const world = (): World => {
  const disk = new FakeDisk();
  disk.dir('/work');
  disk.dir('/outside');
  disk.file('/outside/secret.txt', 10);
  const attachments = new Map<string, { filename: string; bytes: Uint8Array }>();
  let counter = 0;
  const files = new AgentFiles({
    fs: disk,
    folderOf: async sessionId => (sessionId === 's1' ? '/work' : undefined),
    readAttachment: async (_sessionId, id) => {
      const found = attachments.get(id);
      if (found === undefined) throw new Error('no such attachment');
      return found;
    },
    uploadDirectory: '/upload',
    token: () => {
      counter += 1;
      return `t${String(counter)}`;
    },
  });
  return { disk, files, attachments };
};

const refusal = async (work: Promise<unknown>): Promise<AgentFileError> => {
  const error = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  should(error).be.instanceOf(AgentFileError);
  return error as AgentFileError;
};

const SAVE = { maxBytes: AGENT_FILE_LIMITS.downloadBytes };
const staged = { path: '/stage/dl-1', name: 'report.csv', size: 100 };

const stagedWorld = (): World => {
  const made = world();
  made.disk.dir('/stage');
  made.disk.file('/stage/dl-1', 100);
  return made;
};

describe('AgentFiles — the session folder', () => {
  it('should refuse a session with no folder, and a folder that is not there', async () => {
    const { files, disk } = world();
    disk.entries.delete('/work');

    should((await refusal(files.prepareUpload('nobody', ['a.txt']))).code).equal('not_found');
    should((await refusal(files.prepareUpload('s1', ['a.txt']))).code).equal('unavailable');
  });
});

describe('AgentFiles.prepareUpload', () => {
  it('should accept a file inside the folder with its real size and release nothing it did not place', async () => {
    const { files, disk } = world();
    disk.file('/work/a.txt', 5);

    const prepared = await files.prepareUpload('s1', ['a.txt']);
    await prepared.release();

    should(prepared.files).deepEqual([{ path: '/work/a.txt', name: 'a.txt', size: 5 }]);
    should(disk.removed).deepEqual([]);
  });

  it('should refuse a missing file, a folder, an oversize file, and a link that leads outside', async () => {
    const { files, disk } = world();
    disk.dir('/work/sub');
    disk.file('/work/huge.bin', AGENT_FILE_LIMITS.fileBytes + 1);
    disk.link('/work/escape', '/outside');

    should(await refusal(files.prepareUpload('s1', ['nope.txt']))).match({
      code: 'not_found',
      message: 'no file at nope.txt',
    });
    should(await refusal(files.prepareUpload('s1', ['sub']))).match({
      code: 'bad_request',
      message: 'sub is not a file',
    });
    should((await refusal(files.prepareUpload('s1', ['huge.bin']))).message).containEql('over the upload size limit');
    should((await refusal(files.prepareUpload('s1', ['escape/secret.txt']))).code).equal('forbidden');
  });

  it('should copy an attachment into a private directory of the daemon and remove it on release', async () => {
    // Arrange
    const { files, disk, attachments } = world();
    attachments.set('att_1', { filename: '../evil/CV final.pdf', bytes: new Uint8Array(7) });

    // Act
    const prepared = await files.prepareUpload('s1', [{ attachment: 'att_1' }]);

    // Assert
    should(prepared.files).deepEqual([{ path: '/upload/t1/CV final.pdf', name: 'CV final.pdf', size: 7 }]);
    should(disk.modes).deepEqual([
      ['/upload/t1', 0o700],
      ['/upload/t1/CV final.pdf', 0o600],
    ]);
    await prepared.release();
    await prepared.release();
    should(disk.entries.has('/upload/t1/CV final.pdf')).be.false();
    should(disk.removed).deepEqual(['/upload/t1']);
  });

  it('should refuse an attachment this session does not have, or one over the size cap', async () => {
    const { files, attachments } = world();
    attachments.set('att_big', { filename: 'big.bin', bytes: new Uint8Array(AGENT_FILE_LIMITS.fileBytes + 1) });

    should(await refusal(files.prepareUpload('s1', [{ attachment: 'att_none' }]))).match({ code: 'not_found' });
    should((await refusal(files.prepareUpload('s1', [{ attachment: 'att_big' }]))).message).containEql(
      'over the upload size limit',
    );
  });

  it('should refuse a call over the per-call byte or file count, and clean up what it had placed', async () => {
    // Arrange
    const { files, disk, attachments } = world();
    attachments.set('att_1', { filename: 'one.bin', bytes: new Uint8Array(1) });
    disk.file('/work/a.bin', 1);
    disk.file('/work/big.bin', AGENT_FILE_LIMITS.fileBytes);
    const many = Array.from({ length: AGENT_FILE_LIMITS.files + 1 }, () => 'a.bin');

    // Act
    const tooMany = await refusal(files.prepareUpload('s1', [{ attachment: 'att_1' }, ...many]));
    const tooBig = await refusal(files.prepareUpload('s1', ['big.bin', 'big.bin', 'big.bin', 'big.bin', 'big.bin']));

    // Assert
    should(tooMany.message).containEql('at most 20 files');
    should(tooBig.message).containEql('in all');
    should(disk.removed).deepEqual(['/upload/t1']);
  });

  it('should leave the directory alone when removing a placed one fails', async () => {
    const { files, disk, attachments } = world();
    attachments.set('att_1', { filename: 'one.bin', bytes: new Uint8Array(1) });
    const prepared = await files.prepareUpload('s1', [{ attachment: 'att_1' }]);
    disk.failRemove = true;

    await prepared.release();

    should(disk.removed).deepEqual(['/upload/t1']);
  });
});

describe('AgentFiles.save', () => {
  it('should save under downloads/ by the sanitized name and create the folder', async () => {
    const { files, disk } = stagedWorld();

    const saved = await files.save('s1', { ...staged, name: '../a/b:report?.csv' }, SAVE);

    should(saved).deepEqual({ saved: 'downloads/b_report_.csv', name: 'b_report_.csv', size: 100 });
    should(disk.entries.get('/work/downloads/b_report_.csv')).deepEqual({ kind: 'file', size: 100 });
    should(disk.modes).deepEqual([['/work/downloads', 0o755]]);
  });

  it('should save where the agent asked, below the folder, creating what is missing', async () => {
    const { files, disk } = stagedWorld();

    const saved = await files.save('s1', staged, { ...SAVE, saveAs: 'data/2024/out.csv' });

    should(saved.saved).equal('data/2024/out.csv');
    should(disk.entries.has('/work/data/2024/out.csv')).be.true();
  });

  it('should refuse a file over the save size limit, and one that grows past it while copying', async () => {
    const { files, disk } = stagedWorld();

    should((await refusal(files.save('s1', staged, { maxBytes: 99 }))).message).containEql('over the save size limit');
    disk.file('/stage/dl-1', 5000);
    const grown = await refusal(files.save('s1', staged, { maxBytes: 200 }));

    should(grown.message).containEql('grew past');
    should(disk.entries.has('/work/downloads/report.csv')).be.false();
  });

  it('should say the place cannot be written when the copy fails for any other reason', async () => {
    const { files, disk } = stagedWorld();
    disk.entries.delete('/stage/dl-1');

    const error = await refusal(files.save('s1', staged, SAVE));

    should(error).match({ code: 'conflict', message: 'that place cannot be written' });
  });

  it('should refuse the folder itself, "..", an outside path, .git and the daemon’s scratch', async () => {
    const { files } = stagedWorld();
    const attempt = async (saveAs: string) => await refusal(files.save('s1', staged, { ...SAVE, saveAs }));

    should((await attempt('.')).code).equal('bad_request');
    should((await attempt('../x.txt')).code).equal('forbidden');
    should((await attempt('/outside/x.txt')).code).equal('forbidden');
    should((await attempt('.git/hooks/pre-commit')).code).equal('forbidden');
    should((await attempt('attachments/x')).code).equal('forbidden');
  });

  it('should refuse an existing file unless overwrite, and replace it when asked', async () => {
    // Arrange
    const { files, disk } = stagedWorld();
    disk.file('/work/out.csv', 1);

    // Act
    const taken = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'out.csv' }));
    const replaced = await files.save('s1', staged, { ...SAVE, saveAs: 'out.csv', overwrite: true });

    // Assert
    should(taken).match({ code: 'conflict', message: 'out.csv already exists — pass overwrite to replace it' });
    should(replaced).match({ saved: 'out.csv', size: 100 });
    should(disk.entries.get('/work/out.csv')).deepEqual({ kind: 'file', size: 100 });
  });

  it('should never write onto a folder or through a link, even with overwrite', async () => {
    const { files, disk } = stagedWorld();
    disk.dir('/work/sub');
    disk.link('/work/shortcut', '/outside/secret.txt');

    const folder = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'sub', overwrite: true }));
    const link = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'shortcut', overwrite: true }));

    should(folder).match({ code: 'conflict', message: 'sub is a folder' });
    should(link).match({ code: 'forbidden', message: 'a link is never written through' });
    should(disk.entries.get('/outside/secret.txt')).deepEqual({ kind: 'file', size: 10 });
  });

  it('should refuse a folder in the path that is a link leading outside, or one that leads nowhere', async () => {
    const { files, disk } = stagedWorld();
    disk.link('/work/escape', '/outside');
    disk.link('/work/dangling', '/gone');

    const outside = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'escape/x.csv' }));
    const nowhere = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'dangling/x.csv' }));

    should(outside.code).equal('forbidden');
    should(nowhere).match({ code: 'forbidden', message: 'that place cannot be resolved' });
    should(disk.entries.has('/outside/x.csv')).be.false();
  });

  it('should refuse an existing file when its folder is really a link leading outside', async () => {
    const { files, disk } = stagedWorld();
    disk.link('/work/escape', '/outside');
    disk.file('/work/escape/secret.txt', 10);
    disk.entries.set('/work/escape/secret.txt', { kind: 'file', size: 10 });

    const error = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'escape/secret.txt', overwrite: true }));

    should(error.code).equal('forbidden');
    should(disk.entries.get('/outside/secret.txt')).deepEqual({ kind: 'file', size: 10 });
  });

  it('should refuse when the folder just made turns out to be a link outside', async () => {
    const { files, disk } = stagedWorld();
    disk.afterMkdirp = path => {
      disk.entries.delete(path);
      disk.link(path, '/outside');
    };

    const error = await refusal(files.save('s1', staged, SAVE));

    should(error.code).equal('forbidden');
    should(disk.entries.has('/outside/report.csv')).be.false();
  });

  it('should write the path as the person sees it when the session folder is itself a link', async () => {
    // Arrange
    const { disk, attachments } = world();
    disk.dir('/real');
    disk.dir('/real/work');
    disk.dir('/stage');
    disk.file('/stage/dl-1', 100);
    disk.link('/linked', '/real/work');
    const linked = new AgentFiles({
      fs: disk,
      folderOf: async () => '/linked',
      readAttachment: async () => ({ filename: 'x', bytes: attachments.get('x')?.bytes ?? new Uint8Array() }),
      uploadDirectory: '/upload',
      token: () => 't',
    });
    disk.file('/linked/out.csv', 1);

    // Act
    const fresh = await linked.save('s1', staged, SAVE);
    const replaced = await linked.save('s1', staged, { ...SAVE, saveAs: 'out.csv', overwrite: true });

    // Assert
    should(fresh.saved).equal('downloads/report.csv');
    should(replaced.saved).equal('out.csv');
  });
});
