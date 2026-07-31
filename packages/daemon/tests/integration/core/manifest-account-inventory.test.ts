import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { ManifestAccountInventory } from '../../../src/adapters/core/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

const manifestRow = {
  id: 'account-primary',
  agent: 'agent-primary',
  kind: 'claude',
  mode: 'auto',
  displayName: 'Primary',
  defaultModel: 'apex',
  models: [{ id: 'apex', available: true }],
  available: true,
};

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
    const subject = await fixture(JSON.stringify({ accounts: [manifestRow] }));
    try {
      // Act
      const accounts = await subject.inventory.accounts();

      // Assert
      should(accounts.map(account => account.id)).eql(['account-primary']);
      should(accounts[0]?.models).eql([{ id: 'apex', available: true }]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should report an empty fleet before the fleet has ever been provisioned', async () => {
    // Arrange — the daemon starts on a fresh host with no manifest on disk
    const subject = await fixture();
    try {
      // Act / Assert
      should(await subject.inventory.accounts()).eql([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should report an empty fleet rather than throw on an unparseable manifest', async () => {
    // Arrange
    const subject = await fixture('{ this is not json');
    try {
      // Act / Assert
      should(await subject.inventory.accounts()).eql([]);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
