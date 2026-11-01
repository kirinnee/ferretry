import { describe, it } from 'bun:test';
import { homedir, userInfo } from 'node:os';
import should from 'should';
import { KernelProgramProof, linuxHost, type ProcessHost } from '../../../src/adapters/system/kernel-program-proof.ts';
import {
  machineProgramHomes,
  profileCouldStandFor,
  type ProfileChain,
  profileChainOf,
  profileProgramOf,
  walkProfileEntry,
} from '../../../src/adapters/system/profile-program.ts';
import type { ReplaceableDisk } from '../../../src/adapters/system/replaceable-file.ts';

/**
 * A PROGRAM FROM THE OWNER'S OWN NIX PROFILE (docs/secure-copy.md, owner decision !A182): proved only when the profile
 * entry walks, through links that stay inside the profile chain, to the very store file a process runs. A Nix store
 * cannot be assumed on every runner, so the chain is a described disk; this machine's own profile is looked at too
 * when it has one.
 */

const ME = process.getuid?.() ?? 1000;
const HOME = '/home/me';
const STORE_GH = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gh-2.0/bin/gh';
const FORGED_GH = '/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-gh/bin/gh';

type Node = { readonly uid?: number; readonly to?: string };

/** Every part a walk will meet is listed, as it would be on a real disk. */
const PROFILE: Record<string, Node> = {
  '/': {},
  '/home': {},
  [HOME]: { uid: ME },
  [`${HOME}/.nix-profile`]: { uid: ME, to: `${HOME}/.local/state/nix/profiles/profile` },
  [`${HOME}/.local`]: { uid: ME },
  [`${HOME}/.local/state`]: { uid: ME },
  [`${HOME}/.local/state/nix`]: { uid: ME },
  [`${HOME}/.local/state/nix/profiles`]: { uid: ME },
  [`${HOME}/.local/state/nix/profiles/profile`]: { uid: ME, to: 'profile-7-link' },
  [`${HOME}/.local/state/nix/profiles/profile-7-link`]: { uid: ME, to: '/nix/store/eeee-user-environment' },
  '/nix': {},
  '/nix/store': {},
  '/nix/store/eeee-user-environment': {},
  '/nix/store/eeee-user-environment/bin': {},
  '/nix/store/eeee-user-environment/bin/gh': { to: '../../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gh-2.0/bin/gh' },
  '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gh-2.0': {},
  '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-gh-2.0/bin': {},
  [STORE_GH]: {},
  '/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-gh': {},
  '/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-gh/bin': {},
  [FORGED_GH]: {},
  [`${HOME}/bin`]: { uid: ME },
  [`${HOME}/bin/gh`]: { uid: ME, to: FORGED_GH },
  '/usr': {},
  '/usr/bin': {},
};

function disk(nodes: Record<string, Node>): ReplaceableDisk {
  return {
    lstat: async path => {
      const node = nodes[path];
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      return { uid: node.uid ?? 0, mode: 0o755, isSymbolicLink: () => node.to !== undefined };
    },
    readlink: async path => nodes[path]?.to ?? (await Promise.reject(new Error(`EINVAL ${path}`))),
  };
}

const CHAIN = profileChainOf(HOME, 'me') as ProfileChain;

describe('the owner profile chain', () => {
  it('should be the profile and the folders Nix keeps it in, for a usable home and account only', () => {
    should(profileChainOf(`${HOME}/`, 'me')).eql({
      bins: [`${HOME}/.nix-profile/bin`],
      linksIn: [
        `${HOME}/.nix-profile/`,
        `${HOME}/.local/state/nix/profiles/`,
        '/nix/var/nix/profiles/per-user/me/',
        '/nix/store/',
      ],
    });
    for (const [home, account] of [
      [undefined, 'me'],
      ['relative', 'me'],
      ['/', 'me'],
      [HOME, undefined],
      [HOME, '../root'],
    ] as const)
      should(profileChainOf(home, account)).be.undefined();
  });

  it('should walk the profile entry, every link inside the chain, to the store file', async () => {
    should(await walkProfileEntry(`${HOME}/.nix-profile/bin/gh`, CHAIN, disk(PROFILE))).equal(STORE_GH);
    should(await walkProfileEntry(`${HOME}/./.nix-profile/bin/../bin/gh`, CHAIN, disk(PROFILE))).equal(STORE_GH);
    // A `..` after a link climbs from where the link LED, as the kernel does: here, out of the store folder.
    should(await walkProfileEntry(`${HOME}/.nix-profile/../.nix-profile/bin/gh`, CHAIN, disk(PROFILE))).be.undefined();
  });

  it('should refuse a link outside the chain, a missing part, a relative entry, a loop and a broken link', async () => {
    should(await walkProfileEntry(`${HOME}/bin/gh`, CHAIN, disk(PROFILE))).be.undefined();
    should(await walkProfileEntry(`${HOME}/.nix-profile/bin/missing`, CHAIN, disk(PROFILE))).be.undefined();
    should(await walkProfileEntry('.nix-profile/bin/gh', CHAIN, disk(PROFILE))).be.undefined();
    const loop = { ...PROFILE, [`${HOME}/.nix-profile`]: { uid: ME, to: `${HOME}/.nix-profile` } };
    should(await walkProfileEntry(`${HOME}/.nix-profile/bin/gh`, CHAIN, disk(loop))).be.undefined();
    const broken: ReplaceableDisk = { ...disk(PROFILE), readlink: async () => await Promise.reject(new Error('EIO')) };
    should(await walkProfileEntry(`${HOME}/.nix-profile/bin/gh`, CHAIN, broken)).be.undefined();
    should(await walkProfileEntry('/', CHAIN, disk(PROFILE))).equal('/');
  });

  it('should prove the store file the profile names, and nothing else', async () => {
    const proved = async (executable: string, nodes: Record<string, Node> = PROFILE) =>
      await profileProgramOf(executable, CHAIN, ME, disk(nodes), ['/usr/bin']);
    should(await proved(STORE_GH)).eql({ name: 'gh', path: STORE_GH });
    // A store copy the profile does not name (nix-store --add), a home copy, a deleted file, a bad name.
    should(await proved(FORGED_GH)).be.undefined();
    should(await proved(`${HOME}/bin/gh`)).be.undefined();
    should(await proved(`${STORE_GH} (deleted)`)).be.undefined();
    should(await proved('/nix/store/x-y/bin/g h')).be.undefined();
    // The profile can never stand for a program a system folder holds: /usr/bin/gh is root's.
    should(await proved(STORE_GH, { ...PROFILE, '/usr/bin/gh': {} })).be.undefined();
  });

  it('should never prove a password or code program through the profile, though the profile names it (M1)', async () => {
    // A ferret's own non-setuid "sudo" in the store, linked from the profile: the walk holds, the name never does.
    const SUDO = '/nix/store/ffffffffffffffffffffffffffffffff-sudo/bin/sudo';
    const faked: Record<string, Node> = {
      ...PROFILE,
      '/nix/store/eeee-user-environment/bin/sudo': { to: SUDO },
      '/nix/store/ffffffffffffffffffffffffffffffff-sudo': {},
      '/nix/store/ffffffffffffffffffffffffffffffff-sudo/bin': {},
      [SUDO]: {},
    };
    should(await walkProfileEntry(`${HOME}/.nix-profile/bin/sudo`, CHAIN, disk(faked))).equal(SUDO);
    should(await profileProgramOf(SUDO, CHAIN, ME, disk(faked), ['/usr/bin'])).be.undefined();
  });

  it('should say a profile program could stand for a name only when no system folder holds it unreplaceably', async () => {
    const could = async (program: string, nodes: Record<string, Node> = PROFILE) =>
      await profileCouldStandFor(program, CHAIN, ME, disk(nodes), ['/usr/bin']);
    should(await could('gh')).be.true();
    // Not in the profile today, but a ferret could add it: the badge says so before it happens.
    should(await could('vercel')).be.true();
    should(await could('gh', { ...PROFILE, '/usr/bin/gh': {} })).be.false();
    // A "system" entry this account could replace proves nothing.
    should(await could('gh', { ...PROFILE, '/usr/bin/gh': { uid: ME } })).be.true();
    for (const program of ['sudo', 'su', 'doas', 'passwd', 'sudoedit', 'ssh', 'scp', 'aws', 'g h'])
      should(await could(program)).be.false();
    should(await profileCouldStandFor('gh', undefined, ME, disk(PROFILE), ['/usr/bin'])).be.false();
    should(await profileCouldStandFor('env', profileChainOf(homedir(), userInfo().username), ME)).be.false();
  });

  it("should give the rules list this machine's own answer", async () => {
    const homes = machineProgramHomes(homedir(), userInfo().username, ME);
    should(await homes.profileCouldStandFor('nonexistent-fy-program')).be.true();
    should(await homes.profileCouldStandFor('sudo')).be.false();
    should(await machineProgramHomes(undefined, undefined, ME).profileCouldStandFor('gh')).be.false();
  });
});

describe('KernelProgramProof.proveProfile', () => {
  const host = (
    uids: { effective: number; real: number } | undefined,
    profile?: ProcessHost['profile'],
  ): ProcessHost => ({
    uids: async () => uids,
    name: async () => undefined,
    executable: async () => undefined,
    heldElsewhere: async () => false,
    ...(profile === undefined ? {} : { profile }),
  });
  const GH = { name: 'gh', path: STORE_GH };

  it('should prove a process of this account through the profile, and never a setuid or root one', async () => {
    should(await new KernelProgramProof(host({ effective: ME, real: ME }, async () => GH)).proveProfile(7)).eql(GH);
    for (const uids of [{ effective: 0, real: ME }, { effective: 0, real: 0 }, undefined])
      should(await new KernelProgramProof(host(uids, async () => GH)).proveProfile(7)).be.undefined();
    should(await new KernelProgramProof(host({ effective: ME, real: ME })).proveProfile(7)).be.undefined();
    should(
      await new KernelProgramProof(host({ effective: ME, real: ME }, async () => GH)).proveProfile(0),
    ).be.undefined();
    const failing = host({ effective: ME, real: ME }, async () => await Promise.reject(new Error('EACCES')));
    should(await new KernelProgramProof(failing).proveProfile(7)).be.undefined();
  });

  it.skipIf(process.platform !== 'linux')(
    'should, on Linux, read this process: bun is not from the owner profile',
    async () => {
      // The runner's bun comes from wherever it was installed; only a profile that names that very file would prove it.
      const proved = await linuxHost(ME).profile?.(process.pid);
      if (proved !== undefined) should(proved.path).equal(process.execPath);
      should(
        await KernelProgramProof.forPlatform('darwin', async () => undefined).proveProfile(process.pid),
      ).be.undefined();
    },
  );
});
