import { describe, it } from 'bun:test';
import should from 'should';
import {
  CountingSealed,
  daemonOver,
  FailingIndex,
  GITHUB_PASSWORD,
  plant,
  SEAL,
  SEED,
  version1,
} from './accounts-fixtures.ts';

/**
 * A STOP AT ANY STEP OF THE MIGRATION LEAVES VERSION 1 IN PLACE OR VERSION 2 COMMITTED (r1-plan §2.3, invariant 5).
 * Each write fails in turn, the daemon "stops" there and boots again over the same files: the store still reads, the
 * same values are masked under the same names, and nothing is swept against a half state.
 */

const V1_BYTES = `${JSON.stringify(version1(), undefined, 2)}\n`;

async function masks(index: FailingIndex, sealed: CountingSealed) {
  return [...(await daemonOver(index, sealed).vault.values()).entries()].sort();
}

const sealedNames = async (sealed: CountingSealed) => Object.keys((await sealed.read())?.entries ?? {}).sort();

describe('a migration that stops part way', () => {
  it('should leave version 1 untouched when keeping its copy fails, and finish at the next boot', async () => {
    const { index, sealed } = await plant();
    const masked = await masks(index, sealed);
    const listed = await daemonOver(index, sealed).directory.list();
    index.failCopy = true;

    const stopped = await daemonOver(index, sealed)
      .directory.prepare()
      .catch((error: unknown) => error);

    should(stopped).be.an.Error();
    should(index.document?.v).equal(1);
    should(index.commits).equal(0);
    should(await masks(index, sealed)).deepEqual(masked);
    // Nothing was swept: the orphan is still there, and still masked.
    should(await sealedNames(sealed)).containEql(SEAL.orphan);
    should(await daemonOver(index, sealed).directory.list()).deepEqual(listed);

    index.failCopy = false;
    const booted = await daemonOver(index, sealed).directory.prepare();
    should(booted.migrated?.accounts).equal(4);
    should(index.version1).equal(V1_BYTES);
    should(await daemonOver(index, sealed).directory.list()).deepEqual(listed);
  });

  it('should leave version 1 in place (its copy kept) when the commit fails, and commit the same at the next boot', async () => {
    const { index, sealed } = await plant();
    const masked = await masks(index, sealed);
    const listed = await daemonOver(index, sealed).directory.list();
    index.failCommit = true;

    const stopped = await daemonOver(index, sealed)
      .directory.prepare()
      .catch((error: unknown) => error);

    should(stopped).be.an.Error();
    should(index.document?.v).equal(1);
    should(index.version1).equal(V1_BYTES);
    should(sealed.writes).equal(0);
    should(await masks(index, sealed)).deepEqual(masked);
    should(await sealedNames(sealed)).containEql(SEAL.orphan);

    index.failCommit = false;
    await daemonOver(index, sealed).directory.prepare();
    should(index.document?.v).equal(2);
    // The copy is the FIRST one, not rewritten by the second boot.
    should(index.version1).equal(V1_BYTES);
    should(await daemonOver(index, sealed).directory.list()).deepEqual(listed);
    should(await masks(index, sealed)).deepEqual(masked.filter(([name]) => !name.includes(SEAL.orphan)));
  });

  it('should keep version 2 committed when the sweep after it fails, the orphan still masked until the next boot', async () => {
    const { index, sealed } = await plant();
    sealed.failing = true;

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(index.document?.v).equal(2);
    should(booted.swept).equal(0);
    should((await masks(index, sealed)).map(([name]) => name)).containEql(`login:unnamed:${SEAL.orphan}`);
    sealed.failing = false;
    should((await daemonOver(index, sealed).directory.prepare()).swept).equal(1);
    const daemon = daemonOver(index, sealed);
    should(await daemon.vault.fill('GITHUB', 'password', 0)).equal(GITHUB_PASSWORD);
    should((await daemon.vault.values()).get('login:GITHUB:totp')).equal(SEED);
  });
});
