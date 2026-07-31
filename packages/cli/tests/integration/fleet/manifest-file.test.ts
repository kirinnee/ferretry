import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileFleetManifestSource } from '../../../src/adapters/fleet/manifest-file';

const ACCOUNT = {
  id: '00000000-0000-4000-8000-00000000c1a0',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'fy-claude-work',
  home: '/state/fleet/homes/work',
  displayName: 'Claude (work)',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
};

const MANIFEST = { version: 1, generatedAt: '2026-07-31T09:00:00.000Z', accounts: [ACCOUNT] };

describe('reading the fleet manifest off disk', () => {
  let directory: string;
  let target: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fy-fleet-'));
    target = join(directory, 'manifest.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('should parse a manifest provisioning wrote', async () => {
    // Arrange
    await writeFile(target, JSON.stringify(MANIFEST));

    // Act
    const actual = await new FileFleetManifestSource(target).load();

    // Assert
    should(actual?.accounts).have.length(1);
    should(actual?.accounts[0]?.wrapper).equal('fy-claude-work');
  });

  it('should answer nothing on a host that has never applied', async () => {
    // Act
    const actual = await new FileFleetManifestSource(join(directory, 'absent.json')).load();

    // Assert — a missing manifest is a normal state, not a failure
    should(actual).be.undefined();
  });

  it('should name the file when it holds something that is not JSON', async () => {
    // Arrange
    await writeFile(target, 'accounts: []\n');

    // Act + Assert
    await should(new FileFleetManifestSource(target).load()).be.rejectedWith(
      new RegExp(`the fleet manifest at ${target} is not valid JSON`, 'u'),
    );
  });

  it('should refuse a manifest that parses but contradicts itself', async () => {
    // Arrange — an available account may not also carry an unavailableReason
    const contradictory = {
      ...MANIFEST,
      accounts: [{ ...ACCOUNT, unavailableReason: 'logged out' }],
    };
    await writeFile(target, JSON.stringify(contradictory));

    // Act + Assert
    await should(new FileFleetManifestSource(target).load()).be.rejectedWith(/invalid fleet manifest/u);
  });

  it('should refuse a manifest declaring the same wrapper twice', async () => {
    // Arrange
    const duplicated = {
      ...MANIFEST,
      accounts: [ACCOUNT, { ...ACCOUNT, id: '00000000-0000-4000-8000-00000000c1a1', home: '/state/fleet/homes/two' }],
    };
    await writeFile(target, JSON.stringify(duplicated));

    // Act + Assert
    await should(new FileFleetManifestSource(target).load()).be.rejectedWith(/duplicate wrapper name/u);
  });
});
