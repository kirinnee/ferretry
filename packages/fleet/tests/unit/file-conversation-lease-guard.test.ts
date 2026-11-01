import { describe, it } from 'bun:test';
import should from 'should';
import { FileConversationLeaseStore, fencedConversationLeaseStore } from '../../src/adapters/file-shared-history.ts';
import {
  ConversationIdSchema,
  type ConversationLeaseClaim,
  ConversationLeaseUnavailableError,
} from '../../src/lib/shared-history.ts';
import { FakeGuardDisk } from './fake-guard-disk.ts';

/**
 * The conversation lease store asks the state-home guard for the `.leases` folder every time it claims or releases,
 * and reaches the lock and every lease THROUGH the folder it was handed. These drive it over the guard's in-memory
 * disk and make the guard answer each way it refuses — the lease folder is, by identity, the state home or one of its
 * folders; its identity changed between the look and the open; it is a link; it cannot be reached through its
 * descriptor — and show the claim and the release refuse, saying why, with nothing on the disk written, unlinked or
 * removed. The guard's own refusals on a real disk are proved by its tests (state-home-guard, descriptor-calls).
 */

const FLEET = '/fy/fleet';
const LEASES = `${FLEET}/shared/claude/.leases`;

/** A state home with its vault key and its API token (a pinned key file), and the claude pool's folder. */
const world = (reach: boolean | 'calls' = true) => {
  const disk = new FakeGuardDisk(reach);
  disk.dir('/fy');
  disk.dir('/fy/state');
  disk.file('/fy/state/secrets.key', 10, 'vault-key');
  disk.file('/fy/api-token', 6, 'token');
  disk.dir('/fy/config');
  disk.dir(FLEET);
  disk.dir(`${FLEET}/shared`);
  disk.dir(`${FLEET}/shared/claude`);
  const store = new FileConversationLeaseStore(
    FLEET,
    { startOf: async () => undefined },
    {
      fence: { homes: ['/fy', '/fy/state', '/fy/config'], open: [], pinned: ['/fy/api-token'] },
      disk,
      loadLock: () => ({ tryLock: () => true }),
    },
  );
  return { disk, store };
};

/** `api-token` is a plain name the id grammar has to allow: only the guard can keep it out of the home. */
const CLAIM: ConversationLeaseClaim = {
  harness: 'claude',
  conversation: ConversationIdSchema.parse('api-token'),
  holder: { pid: 10, session: 's-1' },
};

const unknown = async (): Promise<'unknown'> => 'unknown';

/** Every name on the disk and what it is, so a test can prove nothing was written, unlinked or removed. */
const layout = (disk: FakeGuardDisk): readonly string[] =>
  [...disk.entries]
    .filter(([name]) => name === '/fy' || name.startsWith('/fy/'))
    .filter(([name]) => !name.startsWith(`${FLEET}/`))
    .map(([name, entry]) => `${name}:${entry.kind}:${entry.kind === 'file' ? entry.text : ''}`)
    .toSorted();

const refusalOf = async (attempt: Promise<unknown>): Promise<Error> => {
  const outcome = await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error('expected the lease step to be refused');
  return outcome;
};

/** The ways the guard refuses the `.leases` folder at the moment a claim or a release reaches it. */
const REFUSALS: readonly (readonly [string, (disk: FakeGuardDisk) => void, RegExp])[] = [
  ["is the state home's own folder by identity", disk => disk.bind(LEASES, '/fy'), /inside this daemon's state home/u],
  ['is the state folder by identity', disk => disk.bind(LEASES, '/fy/state'), /inside this daemon's state home/u],
  ['is a link into the state home', disk => disk.link(LEASES, '/fy'), /a symbolic link stands where a folder must be/u],
  [
    'changed identity between the look and the open',
    disk => {
      disk.dir(LEASES, 0o700);
      disk.beforeOpen = path => {
        if (!path.endsWith('/.leases')) return;
        disk.beforeOpen = undefined;
        disk.move(LEASES, `${LEASES}-was`);
        disk.link(LEASES, '/fy');
      };
    },
    /the state-home guard refused it \(changed\)/u,
  ],
];

const STEPS: readonly (readonly [string, (store: FileConversationLeaseStore) => Promise<unknown>])[] = [
  ['claim', async store => await store.claim(CLAIM, unknown)],
  ['releaseSession', async store => await store.releaseSession('s-1')],
];

describe('FileConversationLeaseStore — the lease folder through the state-home guard', () => {
  for (const reach of [true, 'calls'] as const) {
    for (const [step, act] of STEPS) {
      for (const [why, arrange, refusal] of REFUSALS) {
        it(`should refuse ${step} when the lease folder ${why} (${reach === true ? 'descriptor paths' : 'descriptor calls'})`, async () => {
          // Arrange
          const { disk, store } = world(reach);
          arrange(disk);
          const before = layout(disk);

          // Act
          const refused = await refusalOf(act(store));

          // Assert — refused, saying why, and nothing in the home was written, renamed, unlinked or removed.
          should(refused.message).match(refusal);
          should(layout(disk)).deepEqual(before);
          should(disk.entries.get('/fy/api-token')).match({ kind: 'file', text: 'token' });
          should(disk.entries.get('/fy/state/secrets.key')).match({ kind: 'file', text: 'vault-key' });
          should(disk.written).deepEqual([]);
          should(disk.unlinked).deepEqual([]);
          should(disk.removed).deepEqual([]);
        });
      }
    }
  }

  it('should refuse a claim where the lease folder cannot be reached through its descriptor, making nothing', async () => {
    // Arrange — a disk reached by path only, where a swap timed between a check and a step could redirect it.
    const { disk, store } = world(false);
    const before = [...disk.entries.keys()].toSorted();

    // Act
    const refused = await refusalOf(store.claim(CLAIM, unknown));

    // Assert
    should(refused).be.instanceOf(ConversationLeaseUnavailableError);
    should(refused.message).match(/cannot be reached through its descriptor here/u);
    should([...disk.entries.keys()].toSorted()).deepEqual(before);
  });
});

describe('fencedConversationLeaseStore — the store `fy history claim` claims through', () => {
  /** The lease folder is, by identity, the daemon's sessions folder: not a home, but one of its pinned key folders. */
  const pinnedWorld = () => {
    const { disk } = world();
    disk.dir('/fy/state/sessions');
    disk.bind(LEASES, '/fy/state/sessions');
    return disk;
  };
  const options = (disk: FakeGuardDisk) => ({ disk, loadLock: () => ({ tryLock: () => true }) });

  it("should judge the home's pinned key folders, as the daemon does, refusing a lease folder that is one", async () => {
    // Arrange
    const disk = pinnedWorld();
    const store = fencedConversationLeaseStore(
      { stateHome: '/fy', fleetDirectory: FLEET },
      { startOf: async () => undefined },
      options(disk),
    );

    // Act
    const refused = await refusalOf(store.claim(CLAIM, unknown));

    // Assert
    should(refused.message).match(/inside this daemon's state home/u);
    should(disk.written).deepEqual([]);
  });

  it('should be what refuses it: a store given no fence goes on to the lock', async () => {
    // Arrange
    const disk = pinnedWorld();
    const store = new FileConversationLeaseStore(FLEET, { startOf: async () => undefined }, options(disk));

    // Act
    const refused = await refusalOf(store.claim(CLAIM, unknown));

    // Assert — not refused by the guard; it reached the lock file, which this in-memory disk cannot hand over.
    should(refused.message).not.match(/state home/u);
  });
});
