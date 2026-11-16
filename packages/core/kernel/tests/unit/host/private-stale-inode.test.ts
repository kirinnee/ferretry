import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { resolveInRoot } from '../../../host/roots.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A private place is held by the identity (device, inode) the kept index recorded. The index is served for one look
 * interval, and a private file removed in that time frees its inode: the next folder a publish stages in an internal
 * root can be handed that very inode, and the stale key then names an entry that is not a private place. The boot
 * publish of a converted home was refused "root refused: fenced" this way, so the fleet had no homes (MCP servers
 * invisible) until an unrelated write published it again. A hit is now confirmed against the places as they are NOW;
 * a place that is still there is still held.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DISK = nodeFs(() => 'stale-inode');
const LIST = composePrivateFiles([{ id: 'logins', privacy: { private: ['credentials'] } }]);
/** The longest look interval the host allows: the kept snapshot is served for the whole test: only a hit's confirmation can look again. */
const PLACES = { files: LIST, recheckMs: 5000 };
const STAGING = '.fy-fleet-apply.stage';

interface World {
  readonly home: string;
  readonly fleet: string;
  readonly credential: string;
}

async function world(): Promise<World> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-stale-inode-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const credential = `${home}/state/logins/credentials/L1/auth.json`;
  await mkdir(`${home}/state/logins/credentials/L1`, { recursive: true });
  await writeFile(credential, 'private');
  const fleet = `${home}/fleet`;
  await mkdir(`${fleet}/${STAGING}`, { recursive: true });
  return { home, fleet, credential };
}

/**
 * ONE disk for the whole test (the kept index belongs to it): after `reuse(at, as)`, `at` answers `as`, the identity a
 * removed private file had, as a new folder does that was handed the inode the file freed.
 */
function disk(): { readonly fs: HostFs; readonly reuse: (at: string, as: FileIdentity | undefined) => void } {
  const reused = new Map<string, FileIdentity | undefined>();
  return {
    fs: { ...DISK, identity: async path => (reused.has(path) ? reused.get(path) : await DISK.identity(path)) },
    reuse: (at, as) => reused.set(at, as),
  };
}

const asked = async (fs: HostFs, w: World, name: string) =>
  await resolveInRoot(fs, w.home, w.fleet, false, name, undefined, PLACES);

describe('a private place held by a stale key', () => {
  test('a new folder that reuses the inode of a removed private file is not held', async () => {
    const w = await world();
    const credential = await DISK.identity(w.credential);
    const { fs, reuse } = disk();
    // The kept index looks at the home while the credential is still there.
    expect((await asked(fs, w, STAGING)).ok).toBe(true);
    // The credential goes; the staged folder now answers the identity it had. The index still lists that identity.
    await rm(w.credential);

    reuse(`${w.fleet}/${STAGING}`, credential);
    const staged = await asked(fs, w, STAGING);

    expect(staged.ok).toBe(true);
  });

  test('an entry that is still the private file (a link kept under another name) is held', async () => {
    const w = await world();
    const { fs } = disk();
    expect((await asked(fs, w, STAGING)).ok).toBe(true);
    await link(w.credential, `${w.fleet}/alias`);

    const alias = await asked(fs, w, 'alias');

    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.error).toBe('fenced');
  });

  test('an entry that answers the identity of a private file that is still there is held, however old the snapshot', async () => {
    const w = await world();
    const credential = await DISK.identity(w.credential);
    const { fs, reuse } = disk();
    expect((await asked(fs, w, STAGING)).ok).toBe(true);

    reuse(`${w.fleet}/${STAGING}`, credential);
    const staged = await asked(fs, w, STAGING);

    expect(staged.ok).toBe(false);
    if (!staged.ok) expect(staged.error).toBe('fenced');
  });
});
