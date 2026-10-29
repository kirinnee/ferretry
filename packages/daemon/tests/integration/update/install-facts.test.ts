import { describe, it } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyInstallMethod } from '@ferretry/protocol';
import should from 'should';
import { type FactCommandResult, HostInstallFacts, type InstallFactsSeams } from '../../../src/adapters/index.ts';
import { runBounded } from '../../../src/adapters/update/install-facts.ts';

const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-4.28.0';
const HOME = '/home/kirin';

/** A command runner that answers from a table and records what it was asked. */
function runner(table: Readonly<Record<string, FactCommandResult | undefined>>, asked: string[] = []) {
  return async (argv: readonly string[]): Promise<FactCommandResult | undefined> => {
    asked.push(argv.join(' '));
    return table[argv.slice(0, 2).join(' ')];
  };
}

const seams = (overrides: Partial<InstallFactsSeams>): InstallFactsSeams => ({
  product: 'ferretry',
  argv0: `${HOME}/.nix-profile/bin/fyd`,
  execPath: `${STORE}/bin/fyd`,
  main: '/$bunfs/root/fyd',
  homeDirectory: HOME,
  platform: 'linux',
  workingDirectory: '/work',
  which: () => undefined,
  realpath: async path => path,
  ...overrides,
});

describe('the host install facts', () => {
  it('names the nix profile element that holds the daemon, from the launched profile path', async () => {
    const profile = JSON.stringify({ version: 3, elements: { ferretry: { storePaths: [STORE] } } });
    const asked: string[] = [];
    const facts = await new HostInstallFacts(
      seams({ run: runner({ 'nix profile': { code: 0, stdout: profile } }, asked) }),
    ).facts();
    should(facts).containDeep({
      compiled: true,
      launchedPath: `${HOME}/.nix-profile/bin/fyd`,
      nixProfileElement: 'ferretry',
    });
    should(classifyInstallMethod(facts)).deepEqual({ kind: 'nix-profile', element: 'ferretry' });
    // A store path is never a system package, so dpkg and rpm are not asked.
    should(asked).deepEqual(['nix profile list --json']);
  });

  it('answers no element when nix is missing, fails, or prints something else', async () => {
    for (const answer of [undefined, { code: 1, stdout: '' }, { code: 0, stdout: 'not json' }]) {
      const facts = await new HostInstallFacts(seams({ run: runner({ 'nix profile': answer }) })).facts();
      should(facts).containDeep({ nixProfileElement: undefined, homeManagerProfile: false });
    }
  });

  it('asks dpkg, then rpm, and names dnf over yum when it is installed', async () => {
    const standalone = { argv0: '/usr/bin/fyd', execPath: '/usr/bin/fyd' };
    const apt = await new HostInstallFacts(
      seams({ ...standalone, run: runner({ 'dpkg -S': { code: 0, stdout: 'fy: /usr/bin/fyd' } }) }),
    ).facts();
    should(apt.systemPackage).equal('apt');
    const rpm = { 'dpkg -S': { code: 1, stdout: '' }, 'rpm -qf': { code: 0, stdout: 'fy-4.28.0' } };
    should((await new HostInstallFacts(seams({ ...standalone, run: runner(rpm) })).facts()).systemPackage).equal('yum');
    const dnf = seams({
      ...standalone,
      run: runner(rpm),
      which: name => (name === 'dnf' ? '/usr/bin/dnf' : undefined),
    });
    should((await new HostInstallFacts(dnf).facts()).systemPackage).equal('dnf');
    const none = await new HostInstallFacts(seams({ ...standalone, run: runner({}) })).facts();
    should(none.systemPackage).be.undefined();
    const mac = await new HostInstallFacts(seams({ ...standalone, platform: 'darwin', run: runner(rpm) })).facts();
    should(mac.systemPackage).be.undefined();
  });

  it('resolves a relative launch against the working directory, and a bare name through PATH', async () => {
    const relative = await new HostInstallFacts(seams({ argv0: './bin/fyd', run: runner({}) })).facts();
    should(relative.launchedPath).equal('/work/bin/fyd');
    const found = await new HostInstallFacts(
      seams({ argv0: 'fyd', which: () => `${HOME}/.nix-profile/bin/fyd`, run: runner({}) }),
    ).facts();
    should(found.launchedPath).equal(`${HOME}/.nix-profile/bin/fyd`);
    const lost = await new HostInstallFacts(seams({ argv0: 'fyd', run: runner({}) })).facts();
    should(lost.launchedPath).equal(`${STORE}/bin/fyd`);
  });

  it('calls a source run a development build', async () => {
    const facts = await new HostInstallFacts(
      seams({ main: '/work/packages/daemon/bin/fyd.ts', run: runner({}) }),
    ).facts();
    should(facts.compiled).be.false();
  });

  it('resolves links on the real filesystem and runs real bounded commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fy-install-facts-'));
    try {
      const binary = join(directory, 'fyd');
      await writeFile(binary, '');
      await symlink(binary, join(directory, 'link'));
      const facts = await new HostInstallFacts({
        product: 'ferretry',
        argv0: join(directory, 'link'),
        execPath: join(directory, 'link'),
        main: '/$bunfs/root/fyd',
        homeDirectory: HOME,
        platform: 'linux',
        workingDirectory: directory,
        which: () => undefined,
      }).facts();
      should(facts.resolvedPath).endWith('/fyd');
      // Nothing owns a file in a fresh temporary directory, whether or not dpkg and rpm exist here.
      should(facts.systemPackage).be.undefined();
      const missing = await new HostInstallFacts({
        product: 'ferretry',
        argv0: join(directory, 'gone'),
        execPath: join(directory, 'gone'),
        main: '/$bunfs/root/fyd',
        homeDirectory: HOME,
        platform: 'darwin',
        workingDirectory: directory,
        which: () => undefined,
      }).facts();
      should(missing.resolvedPath).equal(join(directory, 'gone'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs a bounded command and says nothing for one that is not installed, on any host', async () => {
    await should(runBounded(['sh', '-c', 'printf ok'], 5_000)).resolvedWith({ code: 0, stdout: 'ok' });
    await should(runBounded(['fy-no-such-executable-anywhere'], 5_000)).resolvedWith(undefined);
  });
});
