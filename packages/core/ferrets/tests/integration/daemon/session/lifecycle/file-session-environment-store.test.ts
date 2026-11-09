import { afterEach, describe, it } from 'bun:test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { diskSessionsRoot } from '@ferretry/kernel/testing';
import { FileSessionEnvironmentStore } from '../../../../../daemon/adapters/session/lifecycle/file-session-environment-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';

/**
 * The per-session credential file, against a real filesystem.
 *
 * The cases here are the ones a happy-path launch never reaches: a session that was never given an
 * environment, a read that fails for a reason that is not "absent", and a publish that dies partway.
 * Each is driven with a real directory shape rather than a stand-in, because this file holds the
 * only copy of a session's plaintext capability.
 */

const SESSION = parseSessionId('20260806-environment');
const CAPABILITY = { FY_SESSION_BOARD_CAPABILITY: 'mine' };
const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function subject(syncFails?: Error): Promise<{
  readonly store: FileSessionEnvironmentStore;
  readonly directory: string;
  readonly reader: () => FileSessionEnvironmentStore;
}> {
  const home = await mkdtemp(join(tmpdir(), 'fy-environment-store-'));
  homes.add(home);
  const { root, folder: directory } = await diskSessionsRoot(home, SESSION, disk =>
    syncFails === undefined
      ? disk
      : {
          ...disk,
          openDirectory: async path => {
            const proven = await disk.openDirectory(path);
            return {
              ...proven,
              // fails only once the credential has been renamed onto its name: the window the case is about
              sync: async () => {
                if (
                  await access(join(directory, 'environment.json')).then(
                    () => true,
                    () => false,
                  )
                )
                  throw syncFails;
                await proven.sync();
              },
            };
          },
        },
  );
  return {
    store: new FileSessionEnvironmentStore(root, SESSION),
    directory,
    reader: () => new FileSessionEnvironmentStore(root, SESSION),
  };
}

async function rejection(promise: Promise<unknown>): Promise<NodeJS.ErrnoException> {
  try {
    await promise;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error('expected the store to refuse, but it resolved');
}

describe('FileSessionEnvironmentStore', () => {
  it('should launch a session that was never given an environment with none', async () => {
    // Arrange: no file at all — the normal case for most sessions.
    const { store } = await subject();

    // Act + Assert
    should(await store.read(SESSION)).eql({});
  });

  it('should not flatten a read failure that is not absence into "no secret"', async () => {
    // Arrange: the path exists but is a directory, so the root refuses it as "not a file" — a real fault.
    const { store } = await subject();
    await mkdir(store.file(SESSION), { recursive: true });

    // Act
    const failure = await rejection(store.read(SESSION));

    // Assert: launching with half an environment would be worse than refusing to launch.
    should(failure.name).equal('RootError');
    should((failure as unknown as { refusal: string }).refusal).equal('not_a_file');
    should(failure.code).not.equal('ENOENT');
  });

  it('should surface a failed directory sync without unpublishing the credential it already renamed', async () => {
    // Arrange: the rename has succeeded by the time the entry sync fails.
    const failing = await subject(Object.assign(new Error('the directory could not be persisted'), { code: 'EIO' }));

    // Act
    const failure = await rejection(failing.store.write(SESSION, CAPABILITY));

    // Assert: the failure is not swallowed, and the published name is not removed after the fact.
    should(failure.code).equal('EIO');
    should(await readdir(failing.directory)).eql(['environment.json']);
    should(await failing.reader().read(SESSION)).eql(CAPABILITY);
  });

  it('should remove its own temporary and publish nothing when the rename cannot happen', async () => {
    // Arrange: a non-empty directory squatting on the credential's name, so the rename is refused.
    const { store, directory } = await subject();
    await mkdir(join(store.file(SESSION), 'occupied'), { recursive: true });

    // Act
    const failure = await rejection(store.write(SESSION, CAPABILITY));

    // Assert: the failure propagates and the plaintext temporary does not linger beside it.
    should(failure).be.instanceOf(Error);
    should(await readdir(directory)).eql(['environment.json']);
  });

  it('should write and read back one environment', async () => {
    // Arrange
    const { store } = await subject();

    // Act
    await store.write(SESSION, { A: '1', B: '2' });

    // Assert
    should(await store.read(SESSION)).eql({ A: '1', B: '2' });
  });

  it('BG-036 should delete the environment of an ended session, and read as none afterwards', async () => {
    // Arrange
    const { store, directory } = await subject();
    await store.write(SESSION, CAPABILITY);

    // Act
    await store.remove(SESSION);

    // Assert
    should(await readdir(directory)).eql([]);
    should(await store.read(SESSION)).eql({});
  });

  it('BG-036 should treat a missing file, or a session folder that was never made, as already removed', async () => {
    // Arrange: a folder with no file, and a store whose folder does not exist at all.
    const { store, directory } = await subject();
    const never = await subject();
    await rm(never.directory, { recursive: true, force: true });

    // Act + Assert: neither throws, and removing creates nothing.
    await store.write(SESSION, CAPABILITY);
    await store.remove(SESSION);
    await store.remove(SESSION);
    await never.store.remove(SESSION);
    should(await readdir(directory)).eql([]);
    should(
      await access(never.directory).then(
        () => true,
        () => false,
      ),
    ).be.false();
  });

  it('BG-036 should never follow a link at the name: the link goes, what it pointed at stays', async () => {
    // Arrange: environment.json is a link to a file outside the session's folder.
    const { store, directory } = await subject();
    await mkdir(directory, { recursive: true });
    const outside = join(directory, '..', 'outside-target.txt');
    await writeFile(outside, 'must stay');
    await symlink(outside, join(directory, 'environment.json'));

    // Act
    await store.remove(SESSION);

    // Assert
    should(await readdir(directory)).eql([]);
    should(await readFile(outside, 'utf8')).equal('must stay');
  });

  it('BG-036 should refuse, without saying what it held, when the name cannot be removed', async () => {
    // Arrange: the kernel's remove fails with a real fault (not absence).
    const home = await mkdtemp(join(tmpdir(), 'fy-environment-store-'));
    homes.add(home);
    const { root } = await diskSessionsRoot(home, SESSION);
    const failing = new FileSessionEnvironmentStore(
      {
        ...root,
        name: root.name,
        internal: root.internal,
        ensurePrivateDirectory: path => root.ensurePrivateDirectory(path),
        resolve: path => root.resolve(path),
        publish: (...args) => root.publish(...args),
        readBytes: path => root.readBytes(path),
        remove: async () => {
          throw Object.assign(new Error('the disk failed'), { code: 'EIO' });
        },
      },
      SESSION,
    );

    // Act
    const failure = await rejection(failing.remove(SESSION));

    // Assert: a real fault is thrown for the caller to log; only absence is swallowed.
    should(failure.code).equal('EIO');
  });
});
