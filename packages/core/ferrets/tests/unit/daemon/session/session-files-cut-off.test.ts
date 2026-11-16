import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoot } from '@ferretry/kernel/testing';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import type { SessionLifecycleLauncher } from '../../../../daemon/lib/session/lifecycle/index.ts';
import type { TokenCutOff } from '../../../../daemon/lib/tokens/cut-off-mark.ts';
import { SessionFiles } from '../../../../daemon/modules/session-files.ts';
import { memoryStorage, sessionEnvelope } from '../../../support/daemon/storage.ts';

/**
 * ONE cut-off fact, seen from the lifecycle's side: a person's `revoke-credential` through the lifecycle marks the token
 * directory as well as the session document, and a mark only the directory holds still refuses the lifecycle's launch.
 * The service's view of the document's half skips a ferret that has no document. Fakes and temp folders only.
 */

const NOW = '2026-11-08T10:00:00.000Z';
const FERRET = parseSessionId('mw7bp88g-50e00159');
const parents: string[] = [];

afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** The directory's half in memory, counting what the lifecycle wrote to it. */
class Directory implements TokenCutOff {
  readonly cut = new Set<string>();
  async isCutOff(id: string): Promise<boolean> {
    return this.cut.has(id);
  }
  async cutOff(id: string): Promise<void> {
    this.cut.add(id);
  }
  async restore(id: string): Promise<void> {
    this.cut.delete(id);
  }
}

/** A launcher that finds nothing alive and opens nothing: a start that reaches it has passed every credential check. */
const IDLE_LAUNCHER: SessionLifecycleLauncher = {
  alive: async () => false,
  launch: async () => {
    throw new Error('the launcher was reached');
  },
  ready: async () => undefined,
  deliver: async () => undefined,
  snapshot: async () => undefined,
  stop: async () => undefined,
};

async function built(options: { readonly directory?: Directory } = {}) {
  const parent = await mkdtemp(`${tmpdir()}/fy-cut-off-`);
  parents.push(parent);
  await mkdir(`${parent}/work`);
  const sessions = await diskSessionsRoot(parent, FERRET);
  const roots: Pick<RootsPort, 'root'> = { root: (): RootHandle => sessions.root };
  const { storage } = await memoryStorage({ clock: { now: () => NOW } });
  const files = new SessionFiles({
    roots,
    storage,
    clock: { now: () => NOW },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () => [],
    launcher: IDLE_LAUNCHER,
    ...(options.directory === undefined ? {} : { tokenCutOff: options.directory }),
    log: { warn: () => undefined },
  });
  const lifecycle = files.createLifecycle(FERRET, sessionEnvelope());
  await lifecycle.create({ agent: '/opt/fleet/bin/claude', cwd: `${parent}/work`, mode: 'auto', prompt: 'work' });
  return { files, storage, lifecycle };
}

describe('a person revoking a credential through the lifecycle', () => {
  test('should mark the token directory as well as the session document, and erase the credential hash', async () => {
    // Arrange
    const directory = new Directory();
    const { lifecycle, storage } = await built({ directory });

    // Act
    await lifecycle.revokeCredential(FERRET);

    // Assert
    expect(directory.cut.has(FERRET)).toBe(true);
    const document = (await storage.readConfig(FERRET)) as Record<string, unknown>;
    expect(document.credentialRevoked).toBe(true);
    expect(document.capabilityHash).toBeUndefined();
  });

  test('should refuse the lifecycle launch when only the token directory holds the cut-off, before any pane opens', async () => {
    // Arrange — the service cut the ferret off; the document never heard of it
    const directory = new Directory();
    const { lifecycle } = await built({ directory });
    directory.cut.add(FERRET);

    // Act
    const starting = lifecycle.start(FERRET);

    // Assert — refused as a cut-off ferret, and the launcher (which would throw its own error) was never reached
    await expect(starting).rejects.toThrow(`a person revoked ${FERRET}'s credential`);
  });

  test('should clear both marks when a person restores the session, so the lifecycle launches again', async () => {
    // Arrange
    const directory = new Directory();
    const { files, storage, lifecycle } = await built({ directory });
    await lifecycle.revokeCredential(FERRET);

    // Act
    await files.cutOffMark.restore(FERRET);
    await directory.restore(FERRET);

    // Assert
    expect(((await storage.readConfig(FERRET)) as Record<string, unknown>).credentialRevoked).toBeUndefined();
    await expect(lifecycle.start(FERRET)).rejects.toThrow('the launcher was reached');
  });

  test('should still cut the document off when no token directory is bound', async () => {
    // Arrange
    const { lifecycle, storage } = await built();

    // Act
    await lifecycle.revokeCredential(FERRET);

    // Assert
    expect(((await storage.readConfig(FERRET)) as Record<string, unknown>).credentialRevoked).toBe(true);
  });
});

describe('the service’s view of the session document’s cut-off', () => {
  test('should write, read and clear the mark on a ferret that has a document', async () => {
    // Arrange
    const { files, storage } = await built();

    // Act
    const before = await files.cutOffMark.isCutOff(FERRET);
    await files.cutOffMark.cutOff(FERRET);
    const during = await files.cutOffMark.isCutOff(FERRET);
    await files.cutOffMark.restore(FERRET);
    const after = await files.cutOffMark.isCutOff(FERRET);

    // Assert
    expect([before, during, after]).toEqual([false, true, false]);
    expect(await storage.readConfig(FERRET)).toBeDefined();
  });

  test('should skip a ferret that has no session document: nothing is made for it, and it reads not cut off', async () => {
    // Arrange — a document for FERRET only
    const { files, storage } = await built();
    const nobody = parseSessionId('mw7bp88g-aaaa0001');

    // Act
    await files.cutOffMark.cutOff(nobody);
    await files.cutOffMark.restore(nobody);

    // Assert
    expect(await files.cutOffMark.isCutOff(nobody)).toBe(false);
    expect(await storage.readConfig(nobody)).toBeUndefined();
  });
});
