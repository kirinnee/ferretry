import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFleetManifest } from '@ferretry/fleet';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { ManifestAccountInventory } from '../../../src/adapters/core/index.ts';
import {
  createFoundationPaths,
  type FileSystemPort,
  FleetManifestUnreadableError,
  resolveStateHome,
} from '../../../src/lib/index.ts';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

/** One account, in the shape the fleet's own writer produces and nothing else. */
const published = JSON.stringify(
  buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [
      {
        id: ACCOUNT_ID,
        kind: 'claude',
        mode: 'auto',
        wrapper: '/state/fleet/bin/claude-auto-one',
        home: '/state/fleet/homes/auto-one',
        displayName: 'Primary',
        defaultModel: 'apex',
        models: [{ id: 'apex', available: true }],
        available: true,
        unavailableReason: null,
      },
    ],
  }),
);

async function fixture(contents?: string): Promise<{
  readonly home: string;
  readonly inventory: ManifestAccountInventory;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-manifest-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  if (contents !== undefined) {
    await mkdir(dirname(paths.fleetManifest), { recursive: true });
    await writeFile(paths.fleetManifest, contents, 'utf8');
  }
  return { home, inventory: new ManifestAccountInventory(new StateFileSystem(paths), paths.fleetManifest) };
}

describe('ManifestAccountInventory', () => {
  it('should read the accounts the provisioner published', async () => {
    // Arrange
    const subject = await fixture(published);
    try {
      // Act
      const accounts = await subject.inventory.accounts();

      // Assert
      should(accounts.map(account => account.id)).eql([ACCOUNT_ID]);
      should(accounts[0]?.agent).equal('claude-auto-one');
      should(accounts[0]?.wrapper).equal('/state/fleet/bin/claude-auto-one');
      should(accounts[0]?.models).eql([{ id: 'apex', available: true }]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should report an empty fleet before the fleet has ever been provisioned', async () => {
    // Arrange — the daemon starts on a fresh host with no manifest on disk
    const subject = await fixture();
    try {
      // Act / Assert — ABSENT is the one benign case, and it stays benign
      should(await subject.inventory.accounts()).eql([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should refuse a manifest that is present and unreadable, naming the file', async () => {
    // Arrange
    const subject = await fixture('{ this is not json');
    try {
      // Act
      const refusal = await subject.inventory.accounts().catch((error: unknown) => error);

      // Assert — DAMAGED IS NOT EMPTY. Answering `[]` here is what made the daemon report that the
      // manifest published no account while the CLI listed one from the same bytes.
      should(refusal).be.instanceof(FleetManifestUnreadableError);
      should((refusal as Error).message).match(/present but cannot be read/u);
      should((refusal as Error).message).containEql('manifest.json');
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should refuse a manifest whose accounts do not match the published schema', async () => {
    // Arrange — the exact defect: a row shaped the way the daemon USED to imagine one
    const subject = await fixture(
      JSON.stringify({
        accounts: [{ id: 'account-primary', agent: 'agent-primary', kind: 'claude', mode: 'auto', available: true }],
      }),
    );
    try {
      // Act
      const refusal = await subject.inventory.accounts().catch((error: unknown) => error);

      // Assert
      should(refusal).be.instanceof(FleetManifestUnreadableError);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should read the manifest again after the provisioner republishes it, and in full on a filesystem without identities', async () => {
    // Arrange
    const subject = await fixture(published);
    try {
      const paths = createFoundationPaths(resolveStateHome({ fyHome: subject.home, homeDirectory: subject.home }));
      const files = new StateFileSystem(paths);
      const plain = new ManifestAccountInventory(
        { readText: async (path: string) => await files.readText(path) } as unknown as FileSystemPort,
        paths.fleetManifest,
      );
      const first = await subject.inventory.accounts();

      // Act — the provisioner publishes by rename: a new file, so a new identity.
      const next = `${paths.fleetManifest}.next`;
      await writeFile(next, published.replace('"Primary"', '"Renamed"'), 'utf8');
      await rename(next, paths.fleetManifest);
      const republished = await subject.inventory.accounts();
      const unidentified = await plain.accounts();

      // Assert
      should(first[0]?.displayName).equal('Primary');
      should(republished[0]?.displayName).equal('Renamed');
      should(unidentified[0]?.displayName).equal('Renamed');
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
