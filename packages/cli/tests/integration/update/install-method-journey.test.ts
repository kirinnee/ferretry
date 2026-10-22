import { afterEach, beforeEach, describe, it } from 'bun:test';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyInstallMethod, type InstallMethod } from '@ferretry/protocol';
import should from 'should';
import { HostInstallFacts as DaemonInstallFacts } from '../../../../daemon/src/adapters/index.ts';
import { HostInstallFacts as CliInstallFacts } from '../../../src/adapters/update/install-facts.ts';
import { resolveDaemonBinaryPath } from '../../../src/lib/daemon/binary.ts';
import { renderLaunchAgentPlist, renderSystemdUnit } from '../../../src/lib/daemon/unit-file.ts';

/**
 * `fy daemon install` → the unit it writes → the daemon that unit launches, on a fake host.
 *
 * THE JOURNEY IS THE TEST. Classifying a hand-built fact proves the rules; it cannot prove that the
 * path a real install records still leads, link by link, to the facts the rules read. These cases
 * build the symbolic-link chains Nix really makes — a profile link, a symlink-join package, an inner
 * derivation — under a temporary root presented as `/`, then run the install's own path discovery,
 * render the unit, and hand the path the unit names to BOTH fact adapters (`fy`'s and the daemon's),
 * which must agree with each other and with the owner's reality.
 */

const product = 'ferretry';
const hash = (seed: string): string => seed.padEnd(32, '0');
const store = (seed: string, name: string): string => `/nix/store/${hash(seed)}-${name}`;

const INNER = store('inner', 'fyd-4.31.0');
const OUTER = store('outer', 'ferretry');
const HM = store('hm', 'home-manager-path');

const HOME = '/home/kirin';
const PROFILE_ONLY_HM = JSON.stringify({ version: 3, elements: { 'home-manager-path': { storePaths: [HM] } } });
const PROFILE_FERRETRY_AND_HM = JSON.stringify({
  version: 3,
  elements: { ferretry: { storePaths: [OUTER] }, 'home-manager-path': { storePaths: [HM] } },
});
const PROFILE_EMPTY = JSON.stringify({ version: 3, elements: {} });

let root = '';
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fy-install-journey-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The fake host's filesystem, addressed by the paths a real host would show. */
const real = (virtual: string): string => join(root, virtual);
const virtual = (path: string): string => (path.startsWith(root) ? path.slice(root.length) : path);

async function file(path: string): Promise<void> {
  await mkdir(dirname(real(path)), { recursive: true });
  await writeFile(real(path), '#!/bin/sh\n');
  await chmod(real(path), 0o755);
}

async function link(path: string, target: string): Promise<void> {
  await mkdir(dirname(real(path)), { recursive: true });
  await symlink(target.startsWith('/') ? real(target) : target, real(path));
}

/** The package as the flake builds it: a symlink join over the inner derivation. */
async function ferretryPackage(): Promise<void> {
  await file(`${INNER}/bin/fyd`);
  await link(`${OUTER}/bin/fyd`, `${INNER}/bin/fyd`);
}

/** home-manager's generation, with the package installed through `home.packages`. */
async function homeManagerPath(): Promise<void> {
  await ferretryPackage();
  await link(`${HM}/bin/fyd`, `${OUTER}/bin/fyd`);
}

/** `~/.nix-profile` → `…/profiles/profile` → `profile-3-link` → the profile's store path. */
async function userProfile(generation: string): Promise<void> {
  await link(`${HOME}/.nix-profile`, `${HOME}/.local/state/nix/profiles/profile`);
  await link(`${HOME}/.local/state/nix/profiles/profile`, 'profile-3-link');
  await link(`${HOME}/.local/state/nix/profiles/profile-3-link`, generation);
}

interface Scenario {
  readonly platform: 'darwin' | 'linux';
  readonly path: readonly string[];
  readonly profileList: string;
}

/** What `fy daemon install` does to pick and record the daemon, then what the manager launches. */
async function install(scenario: Scenario): Promise<string> {
  const found = scenario.path.map(dir => `${dir}/fyd`).find(candidate => accessible(real(candidate)));
  const binary = resolveDaemonBinaryPath({
    daemonName: 'fyd',
    pinned: undefined,
    found,
    executable: path => accessible(real(path)),
  });
  const spec = {
    daemonBinary: binary.path,
    stateHome: `${HOME}/.ferretry`,
    userHome: HOME,
    logFile: `${HOME}/.ferretry/logs/fyd.log`,
    searchPath: scenario.path.join(':'),
    locale: { LANG: 'C.UTF-8' },
    runtime: {},
    description: 'fyd',
  };
  if (scenario.platform === 'darwin') {
    const plist = renderLaunchAgentPlist({ ...spec, label: 'dev.ferretry.fyd' });
    return plist.match(/<key>ProgramArguments<\/key><array><string>([^<]+)<\/string>/u)?.[1] ?? '';
  }
  return renderSystemdUnit(spec).match(/^ExecStart="(.+)"$/mu)?.[1] ?? '';
}

/** Existence is read synchronously by the install's own rule; a missing path is simply "no". */
function accessible(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The method both adapters conclude for the path a unit names. */
async function classified(scenario: Scenario, launched: string): Promise<readonly InstallMethod[]> {
  const resolve = async (path: string): Promise<string> => virtual(await realpath(real(path)));
  const readLink = async (path: string): Promise<string | undefined> =>
    await readlink(real(path)).then(virtual, () => undefined);
  const run = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
    code: 0,
    stdout: scenario.profileList,
    stderr: '',
  });
  const cli = new CliInstallFacts({
    product,
    homeDirectory: HOME,
    platform: scenario.platform,
    run,
    which: () => undefined,
    realPath: resolve,
    readLink,
  });
  const daemon = new DaemonInstallFacts({
    product,
    argv0: launched,
    execPath: await resolve(launched),
    main: '/$bunfs/root/fyd',
    homeDirectory: HOME,
    platform: scenario.platform,
    workingDirectory: '/',
    which: () => undefined,
    run: async () => ({ code: 0, stdout: scenario.profileList }),
    realpath: resolve,
    readLink,
  });
  return [
    classifyInstallMethod(await cli.facts({ path: launched, source: 'PATH' })),
    classifyInstallMethod(await daemon.facts()),
  ];
}

async function journey(scenario: Scenario): Promise<{ unit: string; methods: readonly InstallMethod[] }> {
  const unit = await install(scenario);
  return { unit, methods: await classified(scenario, unit) };
}

describe('the install method a real install records', () => {
  it('reads a nix profile element through a symlink-join package, with home-manager beside it', async () => {
    await homeManagerPath();
    const generation = store('gen', 'profile');
    await userProfile(generation);
    await link(`${generation}/bin/fyd`, `${OUTER}/bin/fyd`);
    const { unit, methods } = await journey({
      platform: 'linux',
      path: [`${HOME}/.nix-profile/bin`, '/usr/bin'],
      profileList: PROFILE_FERRETRY_AND_HM,
    });
    should(unit).equal(`${HOME}/.nix-profile/bin/fyd`);
    should(methods).deepEqual([
      { kind: 'nix-profile', element: 'ferretry' },
      { kind: 'nix-profile', element: 'ferretry' },
    ]);
  });

  it('reads home-manager standalone, where the profile is the home-manager generation', async () => {
    await homeManagerPath();
    await userProfile(store('gen', 'profile'));
    await link(`${store('gen', 'profile')}/bin`, `${HM}/bin`);
    const { unit, methods } = await journey({
      platform: 'linux',
      path: [`${HOME}/.nix-profile/bin`],
      profileList: PROFILE_ONLY_HM,
    });
    should(unit).equal(`${HOME}/.nix-profile/bin/fyd`);
    should(methods).deepEqual([
      { kind: 'nix-module', manager: 'home-manager' },
      { kind: 'nix-module', manager: 'home-manager' },
    ]);
  });

  it('reads home-manager inside nix-darwin, from the per-user system profile', async () => {
    await homeManagerPath();
    const environment = store('env', 'user-environment');
    await link('/etc/profiles/per-user/kirin', environment);
    await link(`${environment}/bin/fyd`, `${HM}/bin/fyd`);
    const { unit, methods } = await journey({
      platform: 'darwin',
      path: ['/etc/profiles/per-user/kirin/bin', '/run/current-system/sw/bin'],
      profileList: PROFILE_EMPTY,
    });
    should(unit).equal('/etc/profiles/per-user/kirin/bin/fyd');
    should(methods).deepEqual([
      { kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' },
      { kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' },
    ]);
  });

  it('reads home-manager inside NixOS, through the static etc link', async () => {
    await homeManagerPath();
    const etc = store('etc', 'etc');
    const environment = store('env', 'user-environment');
    await link('/etc/profiles', '/etc/static/profiles');
    await link('/etc/static', etc);
    await link(`${etc}/profiles/per-user/kirin`, environment);
    await link(`${environment}/bin/fyd`, `${HM}/bin/fyd`);
    const { unit, methods } = await journey({
      platform: 'linux',
      path: ['/etc/profiles/per-user/kirin/bin'],
      profileList: PROFILE_EMPTY,
    });
    should(unit).equal('/etc/profiles/per-user/kirin/bin/fyd');
    should(methods).deepEqual([
      { kind: 'nix-module', manager: 'home-manager', via: 'nixos' },
      { kind: 'nix-module', manager: 'home-manager', via: 'nixos' },
    ]);
  });

  it('keeps a package the system itself installs a nix-darwin module, in either system profile', async () => {
    await ferretryPackage();
    const system = store('sys', 'system-path');
    await link('/run/current-system/sw', system);
    await link(`${system}/bin/fyd`, `${OUTER}/bin/fyd`);
    const environment = store('env', 'user-environment');
    await link('/etc/profiles/per-user/kirin', environment);
    await link(`${environment}/bin/fyd`, `${OUTER}/bin/fyd`);
    for (const dir of ['/run/current-system/sw/bin', '/etc/profiles/per-user/kirin/bin']) {
      const { unit, methods } = await journey({ platform: 'darwin', path: [dir], profileList: PROFILE_EMPTY });
      should(unit).equal(`${dir}/fyd`);
      should(methods).deepEqual([
        { kind: 'nix-module', manager: 'nix-darwin' },
        { kind: 'nix-module', manager: 'nix-darwin' },
      ]);
    }
  });
});
