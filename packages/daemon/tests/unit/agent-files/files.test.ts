import { describe, it } from 'bun:test';
import should from 'should';
import { AGENT_FILE_LIMITS, AgentFileError, AgentFiles, STAGED_FILE_TTL_MS } from '../../../src/lib/index.ts';
import { FakeAgentDisk } from './fake-disk.ts';

/** The fixed clock every world starts at, so a placed copy is `/upload/<NOW>-t<n>`. */
const NOW = 1_000_000_000;
const placed = (count: number): string => `/upload/${String(NOW)}-t${String(count)}`;

/**
 * A disk with the session folder `/work` and the daemon's state home `/fy` beside it — or, with
 * `folder: '/home'`, a session folder that CONTAINS the state home at `/home/.fy`, the way a session
 * started in the person's home folder contains `~/.ferretry`.
 */
const world = (
  options: { readonly folder?: string; readonly stateHomes?: readonly string[]; readonly token?: () => string } = {},
) => {
  const disk = new FakeAgentDisk();
  const folder = options.folder ?? '/work';
  disk.dir(folder);
  disk.dir('/outside');
  disk.file('/outside/secret.txt', 10);
  disk.dir('/fy');
  disk.dir('/home');
  disk.dir('/home/.fy');
  disk.dir('/home/.fy/state');
  disk.dir('/home/.fy/config');
  disk.file('/home/.fy/api-token', 64);
  disk.file('/home/.fy/state/secrets.key', 32);
  disk.file('/home/.fy/config/daemon.json', 2);
  disk.dir('/stage');
  disk.file('/stage/dl-1', 100);
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
    token:
      options.token ??
      (() => {
        counter += 1;
        return `t${String(counter)}`;
      }),
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

describe('AgentFiles — the session folder and the state home', () => {
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
    should(await refusal(files.save('s1', staged, SAVE))).match({ code: 'unavailable' });
    should(disk.written).deepEqual([]);
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
    should(disk.entries.get(`${placed(1)}/a.txt`)).match({ mode: 0o600 });
    should(disk.entries.get('/work/a.txt')).match({ size: 5 });
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
    should(await refusal(files.prepareUpload('s1', ['escape/secret.txt']))).match({
      code: 'forbidden',
      message: 'that path leads outside this session’s folder, so it is refused',
    });
    should(disk.written).deepEqual([]);
  });

  it('should refuse .git and the daemon’s scratch entries, also when a link inside the folder leads there', async () => {
    const { files, disk } = world();
    disk.dir('/work/.git');
    disk.file('/work/.git/config', 1);
    disk.link('/work/gitconfig', '/work/.git/config');

    should((await refusal(files.prepareUpload('s1', ['.git/config']))).code).equal('forbidden');
    should((await refusal(files.prepareUpload('s1', ['gitconfig']))).message).containEql('.git');
  });

  it('should say a file could not be read whole when the copy fails', async () => {
    const { files, disk } = world({ token: () => 'same' });
    disk.file('/work/a.txt', 5);

    const error = await refusal(files.prepareUpload('s1', ['a.txt', 'a.txt']));

    should(error).match({ code: 'bad_request', message: /could not be read whole/u });
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
});

describe('AgentFiles.sweep — the copies outlive their call by the staging time, no longer', () => {
  it('should remove copies once the staging time is over, keep recent ones, and run before every upload', async () => {
    // Arrange
    const { files, disk, clock } = world();
    disk.file('/work/a.txt', 1);
    await files.prepareUpload('s1', ['a.txt']);
    clock.now = NOW + 60_000;
    await files.prepareUpload('s1', ['a.txt']);
    disk.dir('/upload/left-by-an-older-daemon');
    clock.now = NOW + STAGED_FILE_TTL_MS + 1;

    // Act
    await files.sweep();

    // Assert
    should(disk.removed).deepEqual([placed(1), '/upload/left-by-an-older-daemon']);
    should(await disk.list('/upload')).deepEqual([`${String(NOW + 60_000)}-t2`]);
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
    const { files, disk } = world({ folder: '/home' });

    const token = await refusal(files.prepareUpload('s1', ['.fy/api-token']));
    const absolute = await refusal(files.prepareUpload('s1', ['/home/.fy/state/secrets.key']));

    should(token).match({
      code: 'forbidden',
      rule: 'state-home',
      message:
        "that path is inside this daemon's state home (/home/.fy), which holds this machine's credentials, so the file tools never read there",
    });
    should(absolute).match({ code: 'forbidden', rule: 'state-home' });
    should(disk.written).deepEqual([]);
  });

  it('should refuse a symlink into the state home, a chain of them, and one to a folder in it', async () => {
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
  });

  it('should refuse a file in the state home reached through a second name for it (a bind mount)', async () => {
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    disk.bind('/home/project/mnt', '/home/.fy');

    const error = await refusal(files.prepareUpload('s1', ['project/mnt/api-token']));

    should(error).match({ rule: 'state-home', message: /\/home\/\.fy\)/u });
  });

  it('should refuse a file reached through a state home that is itself a symlink, by its real path', async () => {
    const { files, disk } = world({ folder: '/home', stateHomes: ['/home/.fy-link'] });
    disk.link('/home/.fy-link', '/home/.fy');
    disk.link('/home/token', '/home/.fy/api-token');

    should(await refusal(files.prepareUpload('s1', ['token']))).match({ code: 'forbidden', rule: 'state-home' });
  });

  it('should refuse a hard link, whose other name may be in the state home, and say how to upload it', async () => {
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    disk.hardLink('/home/project/innocent.txt', '/home/.fy/api-token');

    const error = await refusal(files.prepareUpload('s1', ['project/innocent.txt']));

    should(error).match({ code: 'forbidden', rule: 'hard-link', message: /hard link .*copy it and upload the copy/u });
    should(disk.written).deepEqual([]);
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
    should(disk.written).deepEqual([]);
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
  it('should save under downloads/ by the sanitized name, creating the folder, never executable', async () => {
    const { files, disk } = world();

    const saved = await files.save('s1', { ...staged, name: '../a/b:report?.csv' }, SAVE);

    should(saved).deepEqual({ saved: 'downloads/b_report_.csv', name: 'b_report_.csv', size: 100 });
    should(disk.entries.get('/work/downloads/b_report_.csv')).match({ kind: 'file', size: 100, mode: 0o644 });
  });

  it('should save where the agent asked, below the folder, creating what is missing', async () => {
    const { files, disk } = world();

    const saved = await files.save('s1', staged, { ...SAVE, saveAs: 'data/2024/out.csv' });

    should(saved.saved).equal('data/2024/out.csv');
    should(disk.entries.get('/work/data/2024/out.csv')).match({ size: 100 });
  });

  it('should refuse a file over the save size limit, and remove the file it made when the copy fails', async () => {
    const { files, disk } = world();

    should((await refusal(files.save('s1', staged, { maxBytes: 99 }))).message).containEql('over the save size limit');
    const grown = await refusal(files.save('s1', { ...staged, size: 10 }, { maxBytes: 50 }));

    should(grown).match({ code: 'bad_request', message: /could not be saved whole/u });
    should(disk.entries.has('/work/downloads/report.csv')).be.false();
  });

  it('should refuse the folder itself, "..", an outside path, .git and the daemon’s scratch', async () => {
    const { files } = world();
    const attempt = async (saveAs: string) => await refusal(files.save('s1', staged, { ...SAVE, saveAs }));

    should((await attempt('.')).code).equal('bad_request');
    should((await attempt('../x.txt')).code).equal('forbidden');
    should((await attempt('/outside/x.txt')).code).equal('forbidden');
    should((await attempt('.git/hooks/pre-commit')).code).equal('forbidden');
    should((await attempt('attachments/x')).code).equal('forbidden');
  });

  it('should refuse an existing file unless overwrite, and write INTO it when asked, never removing it', async () => {
    // Arrange
    const { files, disk } = world();
    disk.file('/work/out.csv', 1);
    const before = disk.entries.get('/work/out.csv');

    // Act
    const taken = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'out.csv' }));
    const replaced = await files.save('s1', staged, { ...SAVE, saveAs: 'out.csv', overwrite: true });

    // Assert
    should(taken).match({ code: 'conflict', message: 'out.csv already exists — pass overwrite to replace it' });
    should(replaced).match({ saved: 'out.csv', size: 100 });
    should(disk.entries.get('/work/out.csv')).equal(before);
    should(disk.removed).deepEqual([]);
  });

  it('should never write onto a folder or through a link, even with overwrite', async () => {
    const { files, disk } = world();
    disk.dir('/work/sub');
    disk.link('/work/shortcut', '/outside/secret.txt');

    const folder = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'sub', overwrite: true }));
    const link = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'shortcut', overwrite: true }));

    should(folder).match({ code: 'conflict', message: 'sub is a folder' });
    should(link).match({ code: 'forbidden', message: 'a link is never written through' });
    should(disk.entries.get('/outside/secret.txt')).match({ size: 10 });
  });

  it('should refuse a folder in the path that is a link leading outside, or one that leads nowhere', async () => {
    const { files, disk } = world();
    disk.link('/work/escape', '/outside');
    disk.link('/work/dangling', '/gone');

    const outside = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'escape/x.csv' }));
    const nowhere = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'dangling/x.csv' }));

    should(outside.code).equal('forbidden');
    should(nowhere).match({ code: 'forbidden', message: 'that place cannot be resolved' });
    should(disk.entries.has('/outside/x.csv')).be.false();
  });

  it('should refuse when the folder made turns out to lead outside, nowhere, or into .git', async () => {
    // Arrange
    const swapTo = (target: string | undefined) => {
      const made = world();
      made.disk.dir('/work/.git');
      made.disk.afterMkdirp = path => {
        made.disk.entries.delete(path);
        if (target !== undefined) made.disk.link(path, target);
      };
      return made;
    };
    const outside = swapTo('/outside');
    const nowhere = swapTo(undefined);
    const git = swapTo('/work/.git');

    // Act
    const refused = [
      await refusal(outside.files.save('s1', staged, SAVE)),
      await refusal(nowhere.files.save('s1', staged, SAVE)),
      await refusal(git.files.save('s1', staged, SAVE)),
    ];

    // Assert
    should(refused.map(error => error.code)).deepEqual(['forbidden', 'not_found', 'forbidden']);
    should(refused[0]?.message).containEql('outside this session’s folder');
    should(refused[2]?.message).containEql('.git');
    should(outside.disk.entries.has('/outside/report.csv')).be.false();
    should(git.disk.entries.has('/work/.git/report.csv')).be.false();
  });

  it('should refuse a file someone put at the destination while it was being checked', async () => {
    const { files, disk } = world();
    disk.beforeOpen = path => {
      if (path.endsWith('/report.csv') && !disk.entries.has('/work/downloads/report.csv'))
        disk.file('/work/downloads/report.csv', 1);
    };

    should(await refusal(files.save('s1', staged, SAVE))).match({
      code: 'conflict',
      message: 'downloads/report.csv already exists — pass overwrite to replace it',
    });
  });

  it('should write the path as the person sees it when the session folder is itself a link', async () => {
    // Arrange
    const disk = new FakeAgentDisk();
    disk.dir('/real');
    disk.dir('/real/work');
    disk.dir('/fy');
    disk.dir('/stage');
    disk.file('/stage/dl-1', 100);
    disk.link('/linked', '/real/work');
    disk.file('/real/work/out.csv', 1);
    const linked = new AgentFiles({
      fs: disk,
      folderOf: async () => '/linked',
      readAttachment: async () => ({ filename: 'x', bytes: new Uint8Array() }),
      uploadDirectory: '/upload',
      stateHomes: ['/fy'],
      token: () => 't',
      now: () => NOW,
    });

    // Act
    const fresh = await linked.save('s1', staged, SAVE);
    const replaced = await linked.save('s1', staged, { ...SAVE, saveAs: 'out.csv', overwrite: true });

    // Assert
    should(fresh.saved).equal('downloads/report.csv');
    should(replaced.saved).equal('out.csv');
  });
});

describe('AgentFiles.save — never into the daemon’s state home', () => {
  it('should refuse a destination in the state home, named directly or through a link to a folder in it', async () => {
    // Arrange
    const { files, disk } = world({ folder: '/home' });
    disk.link('/home/settings', '/home/.fy/config');
    const attempt = async (saveAs: string, overwrite = false) =>
      await refusal(files.save('s1', staged, { ...SAVE, saveAs, overwrite }));

    // Act
    const refused = [
      await attempt('.fy/config/daemon.json', true),
      await attempt('.fy/config/new.yaml'),
      await attempt('settings/new.yaml'),
      await attempt('settings/deep/new.yaml'),
      await attempt('settings/daemon.json', true),
    ];

    // Assert
    should(refused.map(error => error.rule)).deepEqual([
      'state-home',
      'state-home',
      'state-home',
      'state-home',
      'state-home',
    ]);
    should(refused[0]?.message).containEql('never write there');
    should(disk.entries.get('/home/.fy/config/daemon.json')).match({ size: 2 });
    should(disk.entries.has('/home/.fy/config/new.yaml')).be.false();
  });

  it('should refuse a folder in the state home reached by a second name, and a hard link into it', async () => {
    // Arrange
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/project');
    disk.bind('/home/project/mnt', '/home/.fy');
    disk.hardLink('/home/project/key', '/home/.fy/state/secrets.key');

    // Act
    const bound = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'project/mnt/config/x.json' }));
    const linked = await refusal(files.save('s1', staged, { ...SAVE, saveAs: 'project/key', overwrite: true }));

    // Assert
    should(bound.rule).equal('state-home');
    should(linked).match({ rule: 'hard-link', message: /remove it or save elsewhere/u });
    should(disk.entries.get('/home/.fy/state/secrets.key')).match({ size: 32 });
  });

  it('should refuse — and delete nothing — when downloads/ is swapped for a link into the state home after the check', async () => {
    // Arrange: the folder is checked, then renamed away and a link to the home's state put in its place.
    const { files, disk } = world({ folder: '/home' });
    disk.dir('/home/downloads');
    disk.file('/home/downloads/secrets.key', 1);
    disk.afterOpen = path => {
      if (!path.startsWith('/@fd/')) return;
      disk.move('/home/downloads', '/home/downloads-was');
      disk.link('/home/downloads', '/home/.fy/state');
    };

    // Act
    const error = await refusal(
      files.save(
        's1',
        { ...staged, name: 'secrets.key' },
        { ...SAVE, saveAs: 'downloads/secrets.key', overwrite: true },
      ),
    );

    // Assert
    should(error.rule).equal('changed');
    should(disk.entries.get('/home/.fy/state/secrets.key')).match({ size: 32 });
    should(disk.removed).deepEqual([]);
  });

  it('should still save an ordinary download into a session folder that contains the state home', async () => {
    const { files } = world({ folder: '/home' });

    should((await files.save('s1', staged, SAVE)).saved).equal('downloads/report.csv');
  });
});
