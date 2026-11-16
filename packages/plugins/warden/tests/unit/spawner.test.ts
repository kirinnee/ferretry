import { describe, it } from 'bun:test';
import should from 'should';
import { err, ok } from '@ferretry/std';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ScratchWardenWorkFolders } from '../../daemon/adapters/index.ts';
import { ferretsWardenSpawner } from '../../daemon/spawner.ts';
import { WardenCallsignTakenError, type WardenSpawnRequest } from '../../daemon/lib/index.ts';
import { fakeScratch } from '../support/kernel.ts';

const request = (overrides: Partial<WardenSpawnRequest> = {}): WardenSpawnRequest => ({
  agent: 'acct',
  name: 'Investigate f1',
  prompt: 'look',
  cwd: '',
  teammate: 'warden-000001',
  ...overrides,
});

describe('the Ferrets spawner', () => {
  it('should answer what ran, from the ferret Ferrets started', async () => {
    // Arrange
    const scratch = fakeScratch();
    const ferrets = new FakeFerrets();
    const spawner = ferretsWardenSpawner({ ferrets, folders: new ScratchWardenWorkFolders(scratch) });

    // Act
    const facts = await spawner.spawn(request({ model: 'glm-5.2', effort: 'low' }));

    // Assert
    should(facts.agent).equal('acct');
    should(facts.model).equal('glm-5.2');
    should(facts.modelSource).equal('agent');
    should(ferrets.starts[0]?.options?.effort).equal('low');
    await scratch.closeAll();
  });

  it("should hand a held callsign back as the sweep's own taken-name error", async () => {
    // Arrange
    const scratch = fakeScratch();
    const ferrets = {
      start: async () => err({ code: 'refused', reason: 'callsign "warden-000001" is already claimed' }),
    } as unknown as FerretsApi;
    const spawner = ferretsWardenSpawner({ ferrets, folders: new ScratchWardenWorkFolders(scratch) });

    // Act
    const failure = await spawner.spawn(request()).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(WardenCallsignTakenError);
    await scratch.closeAll();
  });

  it("should fail any other refusal with Ferrets' own words and no prompt", async () => {
    // Arrange
    const scratch = fakeScratch();
    const ferrets = {
      start: async () => err({ code: 'login_unavailable', reason: 'acct is signed out' }),
    } as unknown as FerretsApi;
    const spawner = ferretsWardenSpawner({ ferrets, folders: new ScratchWardenWorkFolders(scratch) });

    // Act
    const failure = (await spawner
      .spawn(request({ prompt: 'SECRET-PROMPT' }))
      .catch((error: unknown) => error)) as Error;

    // Assert
    should(failure.message).containEql('acct is signed out');
    should(failure.message).not.containEql('SECRET-PROMPT');
    await scratch.closeAll();
  });

  it('should read a started ferret that cannot be read back as a failed start', async () => {
    // Arrange
    const scratch = fakeScratch();
    const ferrets = { start: async () => ok('gone'), get: async () => undefined } as unknown as FerretsApi;
    const spawner = ferretsWardenSpawner({ ferrets, folders: new ScratchWardenWorkFolders(scratch) });

    // Act
    const failure = await spawner.spawn(request()).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(Error);
    await scratch.closeAll();
  });
});

describe("the investigators' work folders", () => {
  it('should give each investigator its own folder inside one scratch folder, and remove it on close', async () => {
    // Arrange
    const scratch = fakeScratch();
    const folders = new ScratchWardenWorkFolders(scratch);

    // Act
    const first = await folders.folderFor('warden-000001');
    const second = await folders.folderFor('warden-000002');
    await folders.close();

    // Assert
    should(scratch.opened.length).equal(1);
    should(first).not.equal(second);
    should(first.startsWith(`${scratch.opened[0]}/`)).equal(true);
    should(await Bun.file(first).exists()).equal(false);
  });

  it('should refuse a name that is not a plain callsign, so nothing else becomes a path', async () => {
    // Arrange
    const scratch = fakeScratch();
    const folders = new ScratchWardenWorkFolders(scratch);

    // Act / Assert
    for (const name of ['../escape', 'a/b', '', 'Upper', '.hidden'])
      await folders.folderFor(name).then(
        () => {
          throw new Error(`${name} was accepted`);
        },
        () => undefined,
      );
    await scratch.closeAll();
  });
});
