/**
 * THE MANIFEST INVENTORY, READ ONCE PER FILE.
 *
 * An in-memory state home stands in for the filesystem: each published manifest is a new identity, as a
 * rename makes one. What must hold: an ask that finds the same file answers the accounts it read with one
 * `stat`; a republished, removed or damaged file is read again; a damaged file refuses on every ask and is
 * never kept; and a filesystem without identities is read in full every time.
 */
import { describe, it } from 'bun:test';
import { buildFleetManifest } from '@ferretry/fleet';
import should from 'should';
import { ManifestAccountInventory } from '../../../src/adapters/core/index.ts';
import { FleetManifestUnreadableError, type FileSystemPort } from '../../../src/lib/index.ts';

const MANIFEST = '/state/fleet/manifest.json';

const published = (displayName: string): string =>
  JSON.stringify(
    buildFleetManifest({
      generatedAt: '2027-01-15T08:00:00.000Z',
      accounts: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          kind: 'claude',
          mode: 'auto',
          wrapper: '/state/fleet/bin/claude-auto-one',
          home: '/state/fleet/homes/auto-one',
          displayName,
          defaultModel: 'apex',
          models: [{ id: 'apex', available: true }],
          available: true,
          unavailableReason: null,
        },
      ],
    }),
  );

/** The state home, in memory: the file at the manifest's path, the identity a rename gave it, and every call. */
class StateHome {
  text: string | undefined = published('Primary');
  generation = 1;
  identities = 0;
  reads = 0;

  /** The provisioner publishing a new manifest, by rename: a new file, so a new identity. */
  publish(text: string | undefined): void {
    this.text = text;
    this.generation += 1;
  }

  files(identified = true): FileSystemPort {
    const identity = (): string | undefined => (this.text === undefined ? undefined : `inode-${this.generation}`);
    const base = {
      readText: async () => {
        this.reads += 1;
        return this.text;
      },
    };
    return (identified
      ? {
          ...base,
          identity: async () => {
            this.identities += 1;
            return identity();
          },
          readTextIdentified: async () => {
            this.reads += 1;
            const now = identity();
            return this.text === undefined || now === undefined ? undefined : { text: this.text, identity: now };
          },
        }
      : base) as unknown as FileSystemPort;
  }
}

const names = async (inventory: ManifestAccountInventory): Promise<readonly (string | undefined)[]> =>
  (await inventory.accounts()).map(account => account.displayName);

describe('ManifestAccountInventory keeps what it read', () => {
  it('should answer every ask from one read while the file is the same one', async () => {
    // Arrange
    const home = new StateHome();
    const subject = new ManifestAccountInventory(home.files(), MANIFEST);

    // Act
    const first = await subject.accounts();
    const again = await subject.accounts();
    const later = await subject.accounts();

    // Assert — one read; every later ask is one stat.
    should(home.reads).equal(1);
    should(home.identities).equal(3);
    should(again).equal(first);
    should(later).equal(first);
  });

  it('should read the manifest again once the provisioner republishes it', async () => {
    // Arrange
    const home = new StateHome();
    const subject = new ManifestAccountInventory(home.files(), MANIFEST);
    await subject.accounts();

    // Act
    home.publish(published('Renamed'));
    const republished = await names(subject);

    // Assert
    should(republished).eql(['Renamed']);
    should(home.reads).equal(2);
  });

  it('should answer an empty fleet once the manifest is gone, and read it when it is back', async () => {
    // Arrange
    const home = new StateHome();
    const subject = new ManifestAccountInventory(home.files(), MANIFEST);
    await subject.accounts();

    // Act
    home.publish(undefined);
    const gone = await subject.accounts();
    home.publish(published('Back'));
    const back = await names(subject);

    // Assert
    should(gone).eql([]);
    should(back).eql(['Back']);
  });

  it('should refuse a damaged manifest on every ask and never keep it', async () => {
    // Arrange
    const home = new StateHome();
    const subject = new ManifestAccountInventory(home.files(), MANIFEST);
    await subject.accounts();

    // Act
    home.publish('{"accounts": [');
    const first = await subject.accounts().catch((error: unknown) => error);
    const second = await subject.accounts().catch((error: unknown) => error);
    home.publish(published('Fixed'));
    const fixed = await names(subject);

    // Assert — the earlier good read is not answered for a file that is now damaged.
    should(first).be.instanceOf(FleetManifestUnreadableError);
    should(second).be.instanceOf(FleetManifestUnreadableError);
    should(fixed).eql(['Fixed']);
    should(home.reads).equal(4);
  });

  it('should read the file in full on every ask when the filesystem has no identities', async () => {
    // Arrange
    const home = new StateHome();
    const subject = new ManifestAccountInventory(home.files(false), MANIFEST);

    // Act
    await subject.accounts();
    const again = await names(subject);

    // Assert
    should(again).eql(['Primary']);
    should(home.reads).equal(2);
  });
});
