import { describe, it } from 'bun:test';
import should from 'should';
import { type FactCommand, type FactCommandResult, HostInstallFacts } from '../../daemon/adapters/install-facts.ts';
import { classifyInstallMethod } from '../../contract/index.ts';
import { fakeHost, HOME, STORE } from './host.ts';

/** A command runner that answers from a table and records what it was asked. */
function runner(table: Readonly<Record<string, FactCommandResult | undefined>>, asked: string[] = []): FactCommand {
  return async argv => {
    asked.push(argv.join(' '));
    return table[argv.slice(0, 2).join(' ')];
  };
}

describe('the host install facts', () => {
  it('names the nix profile element that holds the daemon, from the launched profile path', async () => {
    const profile = JSON.stringify({ version: 3, elements: { ferretry: { storePaths: [STORE] } } });
    const asked: string[] = [];
    const facts = await new HostInstallFacts(
      fakeHost(),
      runner({ 'nix profile': { code: 0, stdout: profile } }, asked),
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
      const facts = await new HostInstallFacts(fakeHost(), runner({ 'nix profile': answer })).facts();
      should(facts).containDeep({ nixProfileElement: undefined, homeManagerProfile: false });
    }
  });

  it('asks dpkg, then rpm, and names dnf over yum when it is installed', async () => {
    const standalone = { argv0: '/usr/bin/fyd', execPath: '/usr/bin/fyd' };
    const apt = await new HostInstallFacts(
      fakeHost(standalone),
      runner({ 'dpkg -S': { code: 0, stdout: 'fy: /usr/bin/fyd' } }),
    ).facts();
    should(apt.systemPackage).equal('apt');
    const rpm = { 'dpkg -S': { code: 1, stdout: '' }, 'rpm -qf': { code: 0, stdout: 'fy-4.28.0' } };
    should((await new HostInstallFacts(fakeHost(standalone), runner(rpm)).facts()).systemPackage).equal('yum');
    const dnf = fakeHost({ ...standalone, which: name => (name === 'dnf' ? '/usr/bin/dnf' : undefined) });
    should((await new HostInstallFacts(dnf, runner(rpm)).facts()).systemPackage).equal('dnf');
    const none = await new HostInstallFacts(fakeHost(standalone), runner({})).facts();
    should(none.systemPackage).be.undefined();
    const mac = await new HostInstallFacts(fakeHost({ ...standalone, platform: 'darwin' }), runner(rpm)).facts();
    should(mac.systemPackage).be.undefined();
  });

  it('resolves a relative launch against the working directory, and a bare name through PATH', async () => {
    const relative = await new HostInstallFacts(fakeHost({ argv0: './bin/fyd' }), runner({})).facts();
    should(relative.launchedPath).equal('/work/bin/fyd');
    const found = await new HostInstallFacts(
      fakeHost({ argv0: 'fyd', which: () => `${HOME}/.nix-profile/bin/fyd` }),
      runner({}),
    ).facts();
    should(found.launchedPath).equal(`${HOME}/.nix-profile/bin/fyd`);
    const lost = await new HostInstallFacts(fakeHost({ argv0: 'fyd' }), runner({})).facts();
    should(lost.launchedPath).equal(`${STORE}/bin/fyd`);
  });

  it('calls a source run a development build', async () => {
    const facts = await new HostInstallFacts(fakeHost({ main: '/work/packages/daemon/bin/fyd.ts' }), runner({})).facts();
    should(facts.compiled).be.false();
  });

  it('keeps the path when it cannot be resolved', async () => {
    const facts = await new HostInstallFacts(
      fakeHost({
        realpath: async () => {
          throw new Error('ENOENT');
        },
      }),
      runner({}),
    ).facts();
    should(facts.resolvedPath).equal(`${STORE}/bin/fyd`);
  });
});
