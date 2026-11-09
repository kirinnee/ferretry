import { afterEach, describe, it } from 'bun:test';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from '@ferretry/std';
import should from 'should';
import { diskRoot, diskSessionsRoot } from '@ferretry/kernel/testing';
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

  it('should refuse a damaged document without quoting it, since the file holds a credential', async () => {
    // Arrange: the folder exists after a first read; then the file is cut off mid-secret, and then it is the wrong shape.
    const { store, directory } = await subject();
    await store.read(SESSION);
    await writeFile(join(directory, 'environment.json'), '{"FY_SESSION_TOKEN":"super-secret-token');
    const cut = await rejection(store.read(SESSION));
    await writeFile(join(directory, 'environment.json'), '{"FY_SESSION_TOKEN":42}');

    // Act
    const wrong = await rejection(store.read(SESSION));

    // Assert
    for (const failure of [cut, wrong]) {
      should(failure.message).equal(`the session environment of ${SESSION} is not a valid environment document`);
      should(failure.message).not.containEql('super-secret-token');
    }
  });

  it('should refuse to keep a session’s credential anywhere but the internal sessions root', async () => {
    // Arrange: a person's own work folder is a real root, but never this store's.
    const home = await mkdtemp(join(tmpdir(), 'fy-environment-store-'));
    homes.add(home);
    const { root } = await diskRoot(home);

    // Act
    const build = () => new FileSessionEnvironmentStore(root, SESSION);

    // Assert
    should(build).throw(/internal sessions root only/);
  });

  it('should refuse to make its folder when the root says the folder is outside it', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'fy-environment-store-'));
    homes.add(home);
    const { root } = await diskSessionsRoot(home, SESSION);
    const lost = { ...root, resolve: () => err('outside' as const) } as typeof root;

    // Act
    const failure = await rejection(new FileSessionEnvironmentStore(lost, SESSION).read(SESSION));

    // Assert
    should(failure.message).match(/session folder is outside its root/);
  });

  it('should write and read back one environment', async () => {
    // Arrange
    const { store } = await subject();

    // Act
    await store.write(SESSION, { A: '1', B: '2' });

    // Assert
    should(await store.read(SESSION)).eql({ A: '1', B: '2' });
  });
});
