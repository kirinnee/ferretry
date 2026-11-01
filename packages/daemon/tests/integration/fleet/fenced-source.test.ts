import { afterEach, describe, it } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFolderOutsideStateHomes } from '@ferretry/fleet';
import {
  copyFencedSource,
  copyFencedSourceInto,
  FencedSourceError,
  NodeGuardDisk,
  readFencedSource,
  resolveSourceFence,
} from '@ferretry/fleet/adapters';
import should from 'should';
import { NodeStateHomes } from '../../../src/adapters/system/node-state-homes.ts';

/**
 * The component-source fence and the daemon's state-home port on a REAL disk (docs/secrets.md#what-the-state-home-
 * fence-refuses): what the provisioner copies is refused, by rule, when it is in the state home, a hard link, a loop
 * or missing; a store this user owns proves nothing, so every hard link is refused; and the port resolves the homes
 * the session-file routes and the start refusal judge by.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-fenced-source-')));
  directories.push(directory);
  return directory;
}

/** A state home with its token and asset tree, a folder outside it, and a store this user owns. */
async function machine() {
  const root = await temporary();
  const home = path.join(root, '.ferretry');
  const assets = path.join(home, 'fleet', 'assets');
  const outside = path.join(root, 'notes');
  const store = path.join(root, 'store');
  await mkdir(assets, { recursive: true });
  await mkdir(outside);
  await mkdir(store);
  await writeFile(path.join(home, 'api-token'), 'fy_admin_secret\n');
  await writeFile(path.join(outside, 'CLAUDE.md'), 'Outside guidance.\n');
  const fence = await resolveSourceFence({ homes: [home], open: [assets], hardLinkRoots: [store] });
  return { root, home, assets, outside, store, fence };
}

const refusalOf = async (work: Promise<unknown>): Promise<FencedSourceError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof FencedSourceError)) throw new Error(`expected a FencedSourceError, got ${String(error)}`);
  return error;
};

describe('the fenced copy on a real disk', () => {
  it('should copy into a checked folder, and refuse by rule a source in the home', async () => {
    // Arrange — the provisioner's form: the destination is a folder it opened and checked, written through.
    const { root, home, outside, fence } = await machine();
    const into = path.join(root, 'runtime');
    await mkdir(into);
    const opened = await openFolderOutsideStateHomes(into, fence.homes, new NodeGuardDisk());
    if (!opened.ok) throw new Error(`the destination did not open: ${opened.rule}`);

    try {
      // Act
      await copyFencedSourceInto(fence, outside, opened.value, 'copy');
      const refused = await refusalOf(copyFencedSourceInto(fence, path.join(home, 'api-token'), opened.value, 'token'));

      // Assert
      should(await readFile(path.join(into, 'copy', 'CLAUDE.md'), 'utf8')).eql('Outside guidance.\n');
      should(refused.rule).equal('state-home');
      should(await realpath(path.join(into, 'token')).catch(() => 'absent')).equal('absent');
    } finally {
      await opened.value.close();
    }
  });

  it('should copy a folder outside the home, every link followed', async () => {
    // Arrange
    const { root, outside, fence } = await machine();
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(outside, 'linked.md'));

    // Act
    await copyFencedSource(fence, outside, path.join(root, 'copy'));

    // Assert
    should(await readFile(path.join(root, 'copy', 'linked.md'), 'utf8')).eql('Outside guidance.\n');
  });

  it('should refuse by rule, and say why without the contents: the home, a hard link, a loop, a missing source', async () => {
    // Arrange
    const { root, home, outside, store, fence } = await machine();
    const loop = path.join(root, 'loop');
    await mkdir(loop);
    await symlink(loop, path.join(loop, 'again'));
    await link(path.join(outside, 'CLAUDE.md'), path.join(store, 'twin.md'));

    // Act
    const refusals = [
      await refusalOf(copyFencedSource(fence, path.join(home, 'api-token'), path.join(root, 'a'))),
      await refusalOf(copyFencedSource(fence, path.join(store, 'twin.md'), path.join(root, 'b'))),
      await refusalOf(copyFencedSource(fence, loop, path.join(root, 'c'))),
      await refusalOf(copyFencedSource(fence, path.join(root, 'nowhere'), path.join(root, 'd'))),
    ];

    // Assert: the stand-in store is this user's, so it proves nothing and its hard link is refused too.
    should(refusals.map(refusal => refusal.rule)).deepEqual(['state-home', 'hard-link', 'loop', 'not-found']);
    should(refusals.map(refusal => refusal.message)).match([
      /inside this daemon's state home/u,
      /is a hard link/u,
      /links back into itself/u,
      /does not exist/u,
    ]);
    should(refusals.map(refusal => refusal.message).join('\n')).not.match(/fy_admin_secret/u);
  });

  it('should say why for the rules a copy rarely meets', () => {
    // Act
    const messages = (['changed', 'too-many', 'taken'] as const).map(
      rule => new FencedSourceError('/src', rule).message,
    );

    // Assert
    should(messages).match([/changed while it was being checked/u, /too many files/u, /guard refused it \(taken\)/u]);
  });

  it('should read a document, and read nothing over the limit or behind the fence', async () => {
    // Arrange
    const { home, outside, fence } = await machine();
    const document = path.join(outside, 'CLAUDE.md');

    // Act
    const text = await readFencedSource(fence, document, 1024);
    const tooLarge = await readFencedSource(fence, document, 4);
    const missing = await readFencedSource(fence, path.join(outside, 'nope.md'), 1024);
    const fenced = await refusalOf(readFencedSource(fence, path.join(home, 'api-token'), 1024));

    // Assert
    should([text, tooLarge, missing]).deepEqual(['Outside guidance.\n', undefined, undefined]);
    should(fenced.rule).eql('state-home');
  });
});

describe("the daemon's state-home port on a real disk", () => {
  it('should resolve each home by its name and its real path, with its key files pinned', async () => {
    // Arrange: the home is reached through a symlinked name, as a relocated FY_HOME is.
    const root = await temporary();
    const real = path.join(root, 'real-home');
    await mkdir(real);
    await writeFile(path.join(real, 'api-token'), 'fy_admin_secret\n');
    await symlink(real, path.join(root, 'home'));
    const port = new NodeStateHomes([path.join(root, 'home')], [path.join(root, 'home', 'api-token')]);

    // Act
    const homes = await port.resolve();

    // Assert
    should(homes.homes.map(home => [home.named, home.real])).deepEqual([[path.join(root, 'home'), real]]);
    should(homes.pinned).have.length(1);
  });

  it('should say which home holds a folder, named there or reached through a link, and nothing for one outside', async () => {
    // Arrange
    const root = await temporary();
    const home = path.join(root, 'home');
    await mkdir(path.join(home, 'state'), { recursive: true });
    await mkdir(path.join(root, 'work'));
    await symlink(path.join(home, 'state'), path.join(root, 'innocent'));
    const port = new NodeStateHomes([home]);

    // Act
    const answers = await Promise.all(
      [path.join(home, 'state'), path.join(root, 'innocent'), path.join(root, 'work'), path.join(root, 'nowhere')].map(
        async folder => await port.holding(folder),
      ),
    );

    // Assert
    should(answers).deepEqual([home, home, undefined, undefined]);
  });

  it('should throw when a home cannot be resolved, so the routes refuse an agent', async () => {
    // Arrange
    const root = await temporary();

    // Act
    const failed = await new NodeStateHomes([path.join(root, 'missing')]).resolve().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failed).be.instanceOf(Error);
  });
});
