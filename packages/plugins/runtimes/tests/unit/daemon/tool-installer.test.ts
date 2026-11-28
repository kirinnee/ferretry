/**
 * The tool installer as the daemon composes it (`toolInstaller`): the real command cache, system fact, service and
 * package run over a fake spawn and a fake lookup. What it pins is that the install's own check is made from a fresh
 * lookup, so a tool the install just put on the machine is recognised even when "not found" was cached moments before,
 * and that a POST on a cold daemon plans against managers it has looked up.
 */
import { describe, it } from 'bun:test';
import { REAL_KITS } from '../../support/real-kits.ts';
import should from 'should';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { CommandCache } from '../../../daemon/adapters/command-cache.ts';
import { HostPlatform } from '../../../daemon/adapters/host-platform.ts';
import { toolInstaller } from '../../../daemon/adapters/tool-installer.ts';

const OWNER: CallerGovernance = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' as const }) };

const closed = (text = '') =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== '') controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

function machine() {
  const state = {
    installed: false,
    lookups: [] as string[],
    started: [] as { program: string; args: readonly string[] }[],
  };
  const source = {
    which: async (name: string): Promise<string | undefined> => {
      state.lookups.push(name);
      if (name === 'brew') return '/opt/homebrew/bin/brew';
      if (name === 'claude' && state.installed) return '/opt/homebrew/bin/claude';
      return undefined;
    },
  };
  const spawn: SpawnPort = {
    run: async () => ({ exitCode: 0, signal: null, stdout: 'Darwin\n', stderr: '' }),
    runBytes: async () => {
      throw new Error('not used');
    },
    start: (program, args) => {
      state.started.push({ program, args });
      state.installed = true;
      return {
        pid: 1,
        stdout: closed('==> Installed claude-code\n'),
        stderr: closed(),
        write: () => undefined,
        kill: () => undefined,
        exited: Promise.resolve(0),
        pipes: [],
        closePipes: () => undefined,
      };
    },
  };
  const clock = { after: () => () => undefined, nowMs: () => 1_000 } as unknown as Clock;
  const commands = new CommandCache(source, () => 1_000);
  const platform = new HostPlatform(() => spawn);
  const installer = toolInstaller({ commands, kits: () => REAL_KITS, platform, spawn: () => spawn, clock });
  return { state, commands, platform, installer };
}

describe('toolInstaller', () => {
  it('recognises the tool it just installed although "not found" was cached a moment before', async () => {
    const { state, commands, platform, installer } = machine();
    // The read that shows the Install button: everything primed, claude absent, inside the lookup window.
    await commands.prime(['claude', 'codex', 'npm', 'brew', 'apt-get']);
    await platform.prime();
    should(installer.plans(['claude'])[0]?.installed).equal(false);
    const [outcome] = await installer.install({ harnesses: ['claude'] }, OWNER);
    should(state.started).deepEqual([
      { program: '/opt/homebrew/bin/brew', args: ['install', '--cask', 'claude-code'] },
    ]);
    should(outcome?.outcome).equal('installed');
    should(outcome?.outcome === 'installed' ? outcome.output : []).deepEqual(['==> Installed claude-code']);
  });

  it('plans against managers it has looked up on a cold daemon', async () => {
    const { state, installer } = machine();
    // Nothing primed: the install itself looks the managers and the system up before it plans.
    const [outcome] = await installer.install({ harnesses: ['claude'] }, OWNER);
    should(state.started).have.length(1);
    should(outcome?.outcome).equal('installed');
    should(state.lookups).containEql('brew');
  });
});
