/** The host filesystem adapter against the real kernel: what it describes, what it refuses, and what it cleans up. */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(`${tmpdir()}/fy-node-fs-`);
  directories.push(directory);
  return directory;
}

let counter = 0;
const nextSuffix = (): string => {
  counter += 1;
  return String(counter);
};
const fsUnderTest = (options?: Parameters<typeof nodeFs>[1]) => nodeFs(nextSuffix, options);

/** The class every opened file handle is an instance of, so one call of it can be made to fail. */
async function fileHandlePrototype(directory: string): Promise<Record<string, unknown>> {
  const probe = await open(`${directory}/.probe`, 'w');
  try {
    return Object.getPrototypeOf(probe) as Record<string, unknown>;
  } finally {
    await probe.close();
  }
}

const refusal = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });

describe('describing entries', () => {
  test('a fifo is neither file, directory nor link: it is "other"', async () => {
    const root = await scratch();
    const made = Bun.spawnSync(['mkfifo', `${root}/pipe`]);
    expect(made.exitCode).toBe(0);
    const host = fsUnderTest();
    expect((await host.lstat(`${root}/pipe`))?.kind).toBe('other');
    expect((await host.identity(`${root}/pipe`))?.kind).toBe('other');
  });

  test('a file under a file is not a missing entry for lstat, but is gone for identity', async () => {
    const root = await scratch();
    await writeFile(`${root}/file`, 'x');
    const host = fsUnderTest();
    await expect(host.lstat(`${root}/file/child`)).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await host.identity(`${root}/file/child`)).toBeUndefined();
    expect(await host.lstat(`${root}/absent`)).toBeUndefined();
  });

  test('any other failure to describe an entry is handed back as it came (a link loop)', async () => {
    const root = await scratch();
    await symlink(`${root}/b`, `${root}/a`);
    await symlink(`${root}/a`, `${root}/b`);
    const host = fsUnderTest();
    await expect(host.identity(`${root}/a/child`)).rejects.toMatchObject({ code: 'ELOOP' });
  });
});

describe('row 144: the LEAF of a read is never followed', () => {
  test('row 144 openRead of a link answers ELOOP from the open itself (O_NOFOLLOW on the leaf), a dangling link too', async () => {
    const root = await scratch();
    await writeFile(`${root}/target`, 'FIXTURE');
    await symlink(`${root}/target`, `${root}/link`);
    await symlink(`${root}/absent`, `${root}/dangling`);
    const host = fsUnderTest();
    await expect(host.openRead(`${root}/link`)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(host.openRead(`${root}/dangling`)).rejects.toMatchObject({ code: 'ELOOP' });
  });

  test('row 144 openFile of a link BELOW an open folder answers ELOOP too, and the plain file beside it opens', async () => {
    const root = await scratch();
    await writeFile(`${root}/target`, 'FIXTURE');
    await symlink(`${root}/target`, `${root}/link`);
    const host = fsUnderTest();
    const folder = await host.openDirectory(root);
    try {
      await expect(folder.openFile('link')).rejects.toMatchObject({ code: 'ELOOP' });
      const plain = await folder.openFile('target');
      expect(new TextDecoder().decode(await plain.read())).toBe('FIXTURE');
      await plain.close();
    } finally {
      await folder.close();
    }
  });
});

describe('files and folders', () => {
  test('hard link: creates the second name, refuses an occupied one with EEXIST', async () => {
    const root = await scratch();
    await writeFile(`${root}/one`, 'x');
    const host = fsUnderTest();
    await host.link(`${root}/one`, `${root}/two`);
    expect((await stat(`${root}/one`)).nlink).toBe(2);
    await expect(host.link(`${root}/one`, `${root}/two`)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  test('list answers sorted names, and nothing for a folder that is not there', async () => {
    const root = await scratch();
    await writeFile(`${root}/b`, '');
    await writeFile(`${root}/a`, '');
    const host = fsUnderTest();
    expect(await host.list(root)).toEqual(['a', 'b']);
    expect(await host.list(`${root}/absent`)).toEqual([]);
    await expect(host.list(`${root}/a`)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('opening a folder', () => {
  test('where descriptors are not reached by number the folder offers no entry path', async () => {
    const root = await scratch();
    const host = fsUnderTest({ descriptorFolder: `${root}/no-such-descriptor-folder` });
    const folder = await host.openDirectory(root);
    expect(folder.entryPath('leaf')).toBeUndefined();
    await folder.close();
  });

  test('syncing a folder tolerates the three errnos a filesystem that cannot sync answers, and nothing else', async () => {
    const root = await scratch();
    const prototype = await fileHandlePrototype(root);
    const host = fsUnderTest();
    const folder = await host.openDirectory(root);
    const original = prototype['sync'] as (this: unknown) => Promise<void>;
    const sync = spyOn(prototype, 'sync' as never);
    try {
      for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
        sync.mockImplementationOnce((async () => {
          throw refusal(code);
        }) as never);
        await folder.sync();
      }
      sync.mockImplementationOnce((async () => {
        throw refusal('EIO');
      }) as never);
      await expect(folder.sync()).rejects.toMatchObject({ code: 'EIO' });
    } finally {
      sync.mockRestore();
    }
    await folder.sync();
    expect(prototype['sync']).toBe(original);
    await folder.close();
  });
});

describe('when the kernel breaks a step after the create', () => {
  test('a file this call created but could not describe is removed again, and only while the name is still its own', async () => {
    const root = await scratch();
    const prototype = await fileHandlePrototype(root);
    const host = fsUnderTest();
    const stat = spyOn(prototype, 'stat' as never);
    try {
      // the describe fails once; the follow-up describe in the cleanup works, so the name is proven ours and removed
      stat.mockImplementationOnce((async () => {
        throw refusal('EIO');
      }) as never);
      await expect(host.writeNew(`${root}/made`, 'data', 0o600)).rejects.toMatchObject({ code: 'EIO' });
      expect(await readdir(root)).not.toContain('made');
      // both describes fail: nothing proves the name is ours, so the cleanup leaves it alone
      stat.mockImplementationOnce((async () => {
        throw refusal('EIO');
      }) as never);
      stat.mockImplementationOnce((async () => {
        throw refusal('EIO');
      }) as never);
      await expect(host.writeNew(`${root}/kept`, 'data', 0o600)).rejects.toMatchObject({ code: 'EIO' });
      expect(await readdir(root)).toContain('kept');
    } finally {
      stat.mockRestore();
    }
  });

  test('a file whose describe fails without an exclusive create is closed and left alone', async () => {
    const root = await scratch();
    await writeFile(`${root}/existing`, 'data');
    const prototype = await fileHandlePrototype(root);
    const host = fsUnderTest();
    const stat = spyOn(prototype, 'stat' as never);
    try {
      stat.mockImplementationOnce((async () => {
        throw refusal('EIO');
      }) as never);
      await expect(host.openRead(`${root}/existing`)).rejects.toMatchObject({ code: 'EIO' });
      expect(await readFile(`${root}/existing`, 'utf8')).toBe('data');
    } finally {
      stat.mockRestore();
    }
  });

  test("a failed write removes the partial private file it made, and the error is the write's own", async () => {
    const root = await scratch();
    const prototype = await fileHandlePrototype(root);
    const host = fsUnderTest();
    const writeFileSpy = spyOn(prototype, 'writeFile' as never);
    try {
      writeFileSpy.mockImplementationOnce((async () => {
        throw refusal('ENOSPC');
      }) as never);
      await expect(host.writeNew(`${root}/partial`, 'data', 0o600)).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(await readdir(root)).not.toContain('partial');
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  test('a failed write leaves a file another writer has since put at the name', async () => {
    const root = await scratch();
    const prototype = await fileHandlePrototype(root);
    const host = fsUnderTest();
    const writeFileSpy = spyOn(prototype, 'writeFile' as never);
    try {
      writeFileSpy.mockImplementationOnce((async () => {
        // a concurrent replacing writer renames its own file over the name between the create and the failure
        await writeFile(`${root}/replacement`, 'theirs');
        const { rename } = await import('node:fs/promises');
        await rename(`${root}/replacement`, `${root}/contested`);
        throw refusal('ENOSPC');
      }) as never);
      await expect(host.writeNew(`${root}/contested`, 'data', 0o600)).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(await readFile(`${root}/contested`, 'utf8')).toBe('theirs');
    } finally {
      writeFileSpy.mockRestore();
    }
  });
});

describe('groups and write access', () => {
  test('the groups are the live ones plus every group the group database lists this user in', async () => {
    const root = await scratch();
    const user = userInfo().username;
    const database = `${root}/group`;
    await writeFile(
      database,
      [
        `team:x:4242:other,${user}`,
        'strangers:x:4243:other',
        `bad:x:notanumber:${user}`,
        `solo:x:4244:${user}`,
        '',
      ].join('\n'),
    );
    const groups = await fsUnderTest({ groupDatabase: database }).groups();
    expect(groups).toContain(4242);
    expect(groups).toContain(4244);
    expect(groups).not.toContain(4243);
    expect(groups).toContain(process.getegid?.() ?? -1);
    expect(new Set(groups).size).toBe(groups.length);
  });

  test('without a group database only the live groups count; any other failure to read it throws', async () => {
    const root = await scratch();
    const absent = await fsUnderTest({ groupDatabase: `${root}/absent` }).groups();
    expect(absent).toContain(process.getegid?.() ?? -1);
    await expect(fsUnderTest({ groupDatabase: root }).groups()).rejects.toMatchObject({ code: 'EISDIR' });
  });

  test('writable: true for a folder the user owns, false for one it may not write, an error for a path that is not there', async () => {
    const root = await scratch();
    const locked = `${root}/locked`;
    await mkdir(locked);
    await chmod(locked, 0o500);
    const host = fsUnderTest();
    expect(await host.writable(root)).toBe(true);
    if (process.getuid?.() !== 0) expect(await host.writable(locked)).toBe(false);
    await expect(host.writable(`${root}/absent`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
