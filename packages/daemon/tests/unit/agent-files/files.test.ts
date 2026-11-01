import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import {
  AGENT_FILE_LIMITS,
  AgentFileError,
  type AgentFileIdentity,
  AgentFiles,
  type AgentFilesystem,
  type AgentOpenFile,
  STAGED_FILE_TTL_MS,
} from '../../../src/lib/index.ts';

type Entry =
  | { readonly kind: 'file'; readonly size: number }
  | { readonly kind: 'directory' }
  | { readonly kind: 'other' }
  | { readonly kind: 'link'; readonly target: string };

/** An in-memory disk: files, folders, pipes, links and hard links, resolved the way a real one resolves them. */
class FakeDisk implements AgentFilesystem {
  readonly entries = new Map<string, Entry>([['/', { kind: 'directory' }]]);
  /** Which inode each path names; two paths with one inode are hard links of one file. */
  readonly inodes = new Map<string, number>();
  readonly removed: string[] = [];
  readonly modes: Array<readonly [string, number]> = [];
  readonly copies: string[] = [];
  failRemove = false;
  failList = false;
  afterMkdirp: ((path: string) => void) | undefined;
  /** Runs once a file is opened: what a same-user process could do between the check and the open. */
  afterOpen: ((path: string) => void) | undefined;
  /** Runs before a file is opened, and may throw like a refused open. */
  beforeOpen: ((path: string) => void) | undefined;
  private nextInode = 1;

  dir(path: string): void {
    this.entries.set(path, { kind: 'directory' });
  }
  file(path: string, size: number): void {
    this.entries.set(path, { kind: 'file', size });
    this.inodes.set(path, this.nextInode);
    this.nextInode += 1;
  }
  pipe(path: string): void {
    this.entries.set(path, { kind: 'other' });
  }
  link(path: string, target: string): void {
    this.entries.set(path, { kind: 'link', target });
  }
  /** A second name for the file at `existing`. */
  hardLink(path: string, existing: string): void {
    const entry = this.entries.get(existing);
    if (entry === undefined) throw new Error(`ENOENT ${existing}`);
    this.entries.set(path, entry);
    this.inodes.set(path, this.inodes.get(existing) as number);
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
  async identity(path: string): Promise<AgentFileIdentity | undefined> {
    const entry = this.entries.get(path);
    if (entry === undefined) return undefined;
    const inode = this.inodes.get(path) ?? 0;
    const links = entry.kind === 'file' ? [...this.inodes.values()].filter(other => other === inode).length : 1;
    return { kind: entry.kind, device: 7n, inode: BigInt(inode), links, size: entry.kind === 'file' ? entry.size : 0 };
  }
  async openRead(path: string): Promise<AgentOpenFile> {
    this.beforeOpen?.(path);
    if (this.entries.get(path)?.kind === 'link') throw new Error('ELOOP');
    const identity = await this.identity(await this.realpath(path));
    if (identity === undefined) throw new Error(`ENOENT ${path}`);
    this.afterOpen?.(path);
    return {
      identity,
      copyTo: async (to, maxBytes) => {
        if (identity.size > maxBytes)
          throw new AgentFileError('bad_request', 'that file grew past the upload size limit');
        if (this.entries.has(to)) throw new Error('EEXIST');
        this.file(to, identity.size);
        this.copies.push(to);
        return identity.size;
      },
      close: async () => undefined,
    };
  }
  async list(path: string): Promise<readonly string[]> {
    if (this.failList) throw new Error('EACCES');
    return [...this.entries.keys()]
      .filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
      .map(key => key.slice(path.length + 1));
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

/** The fixed clock every world starts at, so a placed copy is `/upload/<NOW>-t<n>`. */
const NOW = 1_000_000_000;
const placed = (count: number): string => `/upload/${String(NOW)}-t${String(count)}`;

interface World {
  readonly disk: FakeDisk;
  readonly files: AgentFiles;
  readonly attachments: Map<string, { filename: string; bytes: Uint8Array }>;
  readonly clock: { now: number };
}

/**
 * A disk with the session folder `/work` and the daemon's state home `/fy` beside it — or, with
 * `folder: '/home'`, a session folder that CONTAINS the state home at `/home/.fy`, the way a session
 * started in the person's home folder contains `~/.ferretry`.
 */
const world = (options: { readonly folder?: string; readonly stateHomes?: readonly string[] } = {}): World => {
  const disk = new FakeDisk();
  const folder = options.folder ?? '/work';
  disk.dir(folder);
  disk.dir('/outside');
  disk.file('/outside/secret.txt', 10);
  disk.dir('/fy');
  disk.dir('/home');
  disk.dir('/home/.fy');
  disk.dir('/home/.fy/state');
  disk.file('/home/.fy/api-token', 64);
  disk.file('/home/.fy/state/secrets.key', 32);
  const attachments = new Map<string, { filename: string; bytes: Uint8Array }>();
  const clock = { now: NOW };
  let counter = 0;
  const files = new AgentFiles({
    fs: disk,
    folderOf: async sessionId => (sessionId === 's1' ? folder : undefined),
    readAttachment: async (_sessionId, id) => {
      const found = attachments.get(id);
      if (found === undefined) throw new Error('no such attachment');
      return found;
    },
    uploadDirectory: '/upload',
    stateHomes: options.stateHomes ?? (folder === '/home' ? ['/home/.fy', '/home/.fy/state'] : ['/fy']),
    token: () => {
      counter += 1;
      return `t${String(counter)}`;
    },
    now: () => clock.now,
  });
  return { disk, files, attachments, clock };
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

  it('should reach no file at all when the state home cannot be resolved', async () => {
    const { files, disk } = world({ stateHomes: ['/missing-home'] });
    disk.file('/work/a.txt', 5);

    should(await refusal(files.prepareUpload('s1', ['a.txt']))).match({ code: 'unavailable', message: /state home/u });
    should(disk.copies).deepEqual([]);
  });
});

describe('AgentFiles.prepareUpload', () => {
  it('should hand over a COPY of a file in the folder, in a private directory of the daemon, with its real size', async () => {
    // Arrange
    const { files, disk } = world();
    disk.file('/work/a.txt', 5);

    // Act
    const prepared = await files.prepareUpload('s1', ['a.txt']);

    // Assert
    should(prepared.files).deepEqual([{ path: `${placed(1)}/a.txt`, name: 'a.txt', size: 5 }]);
    should(disk.modes).deepEqual([[placed(1), 0o700]]);
    should(disk.entries.get('/work/a.txt')).deepEqual({ kind: 'file', size: 5 });
    await prepared.release();
    should(disk.removed).deepEqual([placed(1)]);
  });

  it('should refuse a missing file, a folder, a pipe, an oversize file, and a link that leads outside', async () => {
    const { files, disk } = world();
    disk.dir('/work/sub');
    disk.pipe('/work/fifo');
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
    should(await refusal(files.prepareUpload('s1', ['fifo']))).match({
      code: 'bad_request',
      message: 'fifo is not a file',
    });
    should((await refusal(files.prepareUpload('s1', ['huge.bin']))).message).containEql('over the upload size limit');
    should((await refusal(files.prepareUpload('s1', ['escape/secret.txt']))).code).equal('forbidden');
    should(disk.copies).deepEqual([]);
  });

  it('should refuse a file the daemon could not open, in plain words', async () => {
    const { files, disk } = world();
    disk.file('/work/a.txt', 5);
    disk.beforeOpen = () => {
      throw new Error('EACCES');
    };

    should(await refusal(files.prepareUpload('s1', ['a.txt']))).match({
      code: 'not_found',
      message: 'a.txt cannot be opened to read',
    });
  });

  it('should copy an attachment into a private directory of the daemon and remove it on release', async () => {
    // Arrange
    const { files, disk, attachments } = world();
    attachments.set('att_1', { filename: '../evil/CV final.pdf', bytes: new Uint8Array(7) });

    // Act
    const prepared = await files.prepareUpload('s1', [{ attachment: 'att_1' }]);

    // Assert
    should(prepared.files).deepEqual([{ path: `${placed(1)}/CV final.pdf`, name: 'CV final.pdf', size: 7 }]);
    should(disk.modes).deepEqual([
      [placed(1), 0o700],
      [`${placed(1)}/CV final.pdf`, 0o600],
    ]);
    await prepared.release();
    await prepared.release();
    should(disk.entries.has(`${placed(1)}/CV final.pdf`)).be.false();
    should(disk.removed).deepEqual([placed(1)]);
  });

  it('should refuse an attachment this session does not have, or one over the size cap', async () => {
    const { files, attachments } = world();
    attachments.set('att_big', { filename: 'big.bin', bytes: new Uint8Array(AGENT_FILE_LIMITS.fileBytes + 1) });

    should(await refusal(files.prepareUpload('s1', [{ attachment: 'att_none' }]))).match({ code: 'not_found' });
    should((await refusal(files.prepareUpload('s1', [{ attachment: 'att_big' }]))).message).containEql(
      'over the upload size limit',
    );
  });

  it('should refuse a call over the per-call byte or file count, and clean up every copy it had placed', async () => {
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
    should(disk.removed).have.length(AGENT_FILE_LIMITS.files + 1 + 5);
    should(await disk.list('/upload')).deepEqual([]);
  });

  it('should leave the directory alone when removing a placed one fails', async () => {
    const { files, disk, attachments } = world();
    attachments.set('att_1', { filename: 'one.bin', bytes: new Uint8Array(1) });
    const prepared = await files.prepareUpload('s1', [{ attachment: 'att_1' }]);
    disk.failRemove = true;

    await prepared.release();

    should(disk.removed).deepEqual([placed(1)]);
  });

  it('should remove the copies of earlier uploads once the staging time is over, and keep the recent ones', async () => {
    // Arrange
    const { files, disk, clock } = world();
    disk.file('/work/a.txt', 1);
    await files.prepareUpload('s1', ['a.txt']);
    clock.now = NOW + 60_000;
    await files.prepareUpload('s1', ['a.txt']);
    disk.dir('/upload/left-by-an-older-daemon');
    clock.now = NOW + STAGED_FILE_TTL_MS + 1;

    // Act
    await files.prepareUpload('s1', ['a.txt']);

    // Assert
    should(disk.removed).deepEqual([placed(1), '/upload/left-by-an-older-daemon']);
    should(await disk.list('/upload')).deepEqual([
      `${String(NOW + 60_000)}-t2`,
      `${String(NOW + STAGED_FILE_TTL_MS + 1)}-t3`,
    ]);
  });

  it('should still upload when the old copies cannot be listed or removed', async () => {
    const { files, disk, clock } = world();
    disk.file('/work/a.txt', 1);
    await files.prepareUpload('s1', ['a.txt']);
    clock.now = NOW + STAGED_FILE_TTL_MS + 1;
    disk.failRemove = true;

    const kept = await files.prepareUpload('s1', ['a.txt']);
    disk.failList = true;
    const unlisted = await files.prepareUpload('s1', ['a.txt']);

    should(kept.files).have.length(1);
    should(unlisted.files).have.length(1);
  });
});

describe('AgentFiles.prepareUpload — never a file in the daemon’s state home', () => {
  it('should refuse the state home named directly, from a session folder that contains it', async () => {
    // Arrange
    const { files, disk } = world({ folder: '/home' });

    // Act
    const token = await refusal(files.prepareUpload('s1', ['.fy/api-token']));
    const absolute = await refusal(files.prepareUpload('s1', ['/home/.fy/state/secrets.key']));

    // Assert
    should(token).match({
      code: 'forbidden',
      rule: 'state-home',
      message:
        "that path is inside this daemon's state home (/home/.fy), which holds this machine's credentials, so the file tools never read there",
    });
    should(absolute).match({ code: 'forbidden', rule: 'state-home' });
    should(disk.copies).deepEqual([]);
  });

  it('should refuse a symlink into the state home, a chain of them, and one to the home itself', async () => {
    // Arrange
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    disk.link('/home/project/token', '/home/.fy/api-token');
    disk.link('/home/project/hop1', '/home/project/hop2');
    disk.link('/home/project/hop2', '/home/project/token');
    disk.link('/home/project/state', '/home/.fy/state');

    // Act
    const refused = await Promise.all(
      ['project/token', 'project/hop1', 'project/state/secrets.key'].map(
        async path => await refusal(files.prepareUpload('s1', [path])),
      ),
    );

    // Assert
    should(refused.map(error => error.rule)).deepEqual(['state-home', 'state-home', 'state-home']);
    should(disk.copies).deepEqual([]);
  });

  it('should refuse a file reached through a state home that is itself a symlink, by its real path', async () => {
    // Arrange: the configured home is a link to where it really lives, and the folder reaches that place.
    const { files, disk } = world({ folder: '/home', stateHomes: ['/home/.fy-link'] });
    disk.link('/home/.fy-link', '/home/.fy');
    disk.link('/home/token', '/home/.fy/api-token');

    // Act
    const error = await refusal(files.prepareUpload('s1', ['token']));

    // Assert
    should(error).match({ code: 'forbidden', rule: 'state-home', message: /\/home\/\.fy\)/u });
  });

  it('should refuse a hard link, whose other name may be in the state home, and say how to upload it', async () => {
    // Arrange
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    disk.hardLink('/home/project/innocent.txt', '/home/.fy/api-token');

    // Act
    const error = await refusal(files.prepareUpload('s1', ['project/innocent.txt']));

    // Assert
    should(error).match({ code: 'forbidden', rule: 'hard-link', message: /hard link .*copy it and upload the copy/u });
    should(disk.copies).deepEqual([]);
  });

  it('should refuse a file swapped for another, for a link, or removed between the check and the open', async () => {
    // Arrange
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    const swaps: Record<string, () => void> = {
      'project/other.txt': () => disk.file('/home/project/other.txt', 3),
      'project/linked.txt': () => disk.link('/home/project/linked.txt', '/home/.fy/api-token'),
      'project/gone.txt': () => disk.entries.delete('/home/project/gone.txt'),
    };
    for (const path of Object.keys(swaps)) disk.file(`/home/${path}`, 3);
    disk.afterOpen = path => swaps[path.slice('/home/'.length)]?.();

    // Act
    const refused = await Promise.all(
      Object.keys(swaps).map(async path => await refusal(files.prepareUpload('s1', [path]))),
    );

    // Assert
    should(refused.map(error => error.rule)).deepEqual(['changed', 'changed', 'changed']);
    should(refused[0]?.message).equal('project/other.txt changed while it was being checked, so it is refused');
    should(disk.copies).deepEqual([]);
  });

  it('should still upload an ordinary file from a session folder that contains the state home', async () => {
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    disk.file('/home/project/report.pdf', 9);

    const prepared = await files.prepareUpload('s1', ['project/report.pdf']);

    should(prepared.files).deepEqual([{ path: `${placed(1)}/report.pdf`, name: 'report.pdf', size: 9 }]);
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
      stateHomes: ['/fy'],
      token: () => 't',
      now: () => NOW,
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

describe('AgentFiles.save — never into the daemon’s state home', () => {
  const homeWorld = (): World => {
    const made = world({ folder: '/home' });
    made.disk.dir('/stage');
    made.disk.file('/stage/dl-1', 100);
    made.disk.dir('/home/.fy/config');
    made.disk.file('/home/.fy/config/daemon.json', 2);
    return made;
  };

  it('should refuse a destination in the state home, named directly or through a link to a folder in it', async () => {
    // Arrange
    const { files, disk } = homeWorld();
    disk.link('/home/settings', '/home/.fy/config');
    const attempt = async (saveAs: string, overwrite = false) =>
      await refusal(files.save('s1', staged, { ...SAVE, saveAs, overwrite }));

    // Act
    const refused = [
      await attempt('.fy/config/daemon.json', true),
      await attempt('.fy/config/new.yaml'),
      await attempt('settings/new.yaml'),
      await attempt('settings/deep/new.yaml'),
    ];

    // Assert
    should(refused.map(error => error.rule)).deepEqual(['state-home', 'state-home', 'state-home', 'state-home']);
    should(refused[0]?.message).containEql('never write there');
    should(disk.entries.get('/home/.fy/config/daemon.json')).deepEqual({ kind: 'file', size: 2 });
    should(disk.entries.has('/home/.fy/config/new.yaml')).be.false();
  });

  it('should refuse replacing a file whose folder is really in the state home', async () => {
    const { files, disk } = homeWorld();
    disk.link('/home/settings', '/home/.fy/config');
    disk.entries.set('/home/settings/daemon.json', { kind: 'file', size: 2 });

    const error = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'settings/daemon.json', overwrite: true }));

    should(error.rule).equal('state-home');
  });

  it('should refuse when the folder just made turns out to be a link into the state home', async () => {
    const { files, disk } = homeWorld();
    disk.afterMkdirp = path => {
      disk.entries.delete(path);
      disk.link(path, '/home/.fy/config');
    };

    const error = await refusal(files.save('s1', staged, SAVE));

    should(error.rule).equal('state-home');
    should(disk.entries.has('/home/.fy/config/report.csv')).be.false();
  });

  it('should still save an ordinary download into a session folder that contains the state home', async () => {
    const { files } = homeWorld();

    const saved = await files.save('s1', staged, SAVE);

    should(saved.saved).equal('downloads/report.csv');
  });
});
