import { describe, it } from 'bun:test';
import should from 'should';
import { isYes, lastLine, NixProfileSwitch } from '../../../src/lib/update/profile-switch';
import { CapturedOutput, FakePrompt } from '../daemon/fixtures';
import { FakeFacts, FakeHost, FakePackages, PROFILE_DAEMON, STORE, USER_HOME } from './fixtures';

const STORE_DAEMON = `${STORE}/bin/fyd`;

function harness(kind: string, options: { interactive?: boolean; answer?: string; executables?: string[] } = {}) {
  const host = new FakeHost(STORE_DAEMON, '1.2.3', true);
  const packages = new FakePackages(host, STORE_DAEMON);
  const out = new CapturedOutput();
  const prompt = new FakePrompt(options.answer ?? 'y');
  const executables = new Set(options.executables ?? [PROFILE_DAEMON]);
  const switcher = new NixProfileSwitch({
    facts: new FakeFacts(kind),
    packages,
    lifecycle: { executable: path => executables.has(path), versionOf: path => host.versions.get(path) },
    out,
    prompt,
    interactive: () => options.interactive ?? true,
    product: 'ferretry',
    clientName: 'fy',
    daemonName: 'fyd',
    homeDirectory: `${USER_HOME}/`,
  });
  return { switcher, host, packages, out, prompt };
}

const daemon = { path: STORE_DAEMON, source: 'PATH' as const, version: '1.2.3' };

describe('NixProfileSwitch', () => {
  it('offers nothing for a daemon that is not a nix shell', async () => {
    const h = harness('nix-profile');
    should(await h.switcher.offer({ ...daemon, path: PROFILE_DAEMON })).be.undefined();
    should(h.out.lines).be.empty();
  });

  it('explains and gives the steps off a terminal, changing nothing', async () => {
    const h = harness('nix-shell', { interactive: false });
    should(await h.switcher.offer(daemon)).be.undefined();
    should(h.out.text).match(/temporary nix shell store path/u);
    should(h.out.text).match(
      /run `nix profile install github:kirinnee\/ferretry`, then `fy daemon install` from a new shell/u,
    );
    should(h.host.trail).be.empty();
  });

  it('installs into the profile on a yes and answers the stable path', async () => {
    const h = harness('nix-shell');
    should(await h.switcher.offer(daemon)).deepEqual({
      path: PROFILE_DAEMON,
      source: 'FY_DAEMON_BIN',
      version: '1.3.0',
    });
    should(h.prompt.asked).deepEqual(['Install ferretry into your nix profile now? [y/N]']);
  });

  it('keeps the store path on a no', async () => {
    const h = harness('nix-shell', { answer: 'nope' });
    should(await h.switcher.offer(daemon)).be.undefined();
    should(h.host.trail).be.empty();
  });

  it('falls back to the store path when the install fails, and says so', async () => {
    const h = harness('nix-shell');
    h.packages.failures.add('nix-install:github:kirinnee/ferretry');
    should(await h.switcher.offer(daemon)).be.undefined();
    should(h.out.text).match(/failed: error: .*; installing the nix shell path instead/u);
  });

  it('finds the XDG profile layout too', async () => {
    const xdg = `${USER_HOME}/.local/state/nix/profile/bin/fyd`;
    const h = harness('nix-shell', { executables: [xdg] });
    should(h.switcher.profilePaths).deepEqual([PROFILE_DAEMON, xdg]);
    should(await h.switcher.install()).deepEqual({ path: xdg });
  });

  it('reads a yes and the last line of output', () => {
    should(['y', 'Yes', ' yes '].map(isYes)).deepEqual([true, true, true]);
    should(['', 'n', 'yess'].map(isYes)).deepEqual([false, false, false]);
    should(lastLine('a\n\n b \n')).equal('b');
    should(lastLine('\n')).be.undefined();
  });
});
