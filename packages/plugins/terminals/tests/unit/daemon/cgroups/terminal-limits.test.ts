import { describe, it } from 'bun:test';
import { GIBIBYTE } from '../../../../daemon/lib/protocol/limits.ts';
import should from 'should';
import { TmuxTerminalRuntime } from '../../../../daemon/adapters/terminal/tmux-terminal-runtime.ts';
import {
  type CgroupCommandPort,
  type CgroupHostFacts,
  CgroupLaunchPlanner,
  EnforcementRuntime,
} from '../../../../daemon/lib/cgroups/index.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';

/**
 * A terminal an agent opens is a separate tmux session, outside the harness's scope. These prove it is launched
 * through the same planner as the ferret, keyed by the daemon's own record of who opened it.
 */
const HOST: CgroupHostFacts = {
  platform: 'linux',
  unifiedHierarchy: true,
  cpus: 32,
  physicalBytes: 61 * GIBIBYTE,
  memoryCeilingBytes: 48 * GIBIBYTE,
  ceilingSource: 'memory.high of user-1000.slice',
  swapBytes: 0,
};
const ok: TmuxCommandResult = { code: 0, stdout: '', stderr: '' };

function build() {
  const received: string[][] = [];
  const tmux: TmuxCommandPort = {
    execute: async argv => {
      received.push([...argv]);
      return ok;
    },
  };
  const commands: CgroupCommandPort = { execute: async () => ({ code: 0, stdout: '', stderr: '' }) };
  const planner = new CgroupLaunchPlanner({
    limits: async () => ({}),
    host: HOST,
    commands,
    sessions: { facts: async () => ({}) },
    enforcement: new EnforcementRuntime(
      async () => ({ kind: 'cgroups', ionice: true }),
      () => 1,
    ),
    nonce: () => 'a1b2c3d4',
  });
  const runtime = new TmuxTerminalRuntime(tmux, () => 1_000, { shell: async () => '/bin/zsh' }, planner);
  const create = async (openedBy?: Parameters<TmuxTerminalRuntime['create']>[0]['openedBy']) =>
    await runtime.create({
      ownerId: 'ses-1',
      id: '0123456789ab',
      title: 'Terminal 1',
      cwd: '/work',
      size: { cols: 100, rows: 30 },
      ...(openedBy === undefined ? {} : { openedBy }),
    });
  return { received, create };
}

/** The words tmux was given to run in the new session: everything between `new-session`'s size flags and the first `;`. */
const launched = (argv: readonly string[]): readonly string[] => argv.slice(argv.indexOf('30') + 1, argv.indexOf(';'));

describe('a terminal an agent opens', () => {
  it('should start inside the fleet slice with the ferret’s caps, through the same planner as the harness', async () => {
    // Arrange
    const { received, create } = build();

    // Act
    await create({ by: 'agent', sessionId: 'ses-1' });

    // Assert
    const words = launched(received[0] as string[]);
    should(words.slice(0, 6)).deepEqual([
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=ferretry-agent-ses-1-ta1b2c3d4.scope',
    ]);
    should(words).containEql('--slice=ferretry_fleet-ses\\x2d1.slice');
    should(words).not.containEql('--property=MemoryMax=15461882265');
    // The shell itself is last, behind the disk-priority wrapper, so it is still a login shell.
    should(words.slice(-6)).deepEqual(['ionice', '-c2', '-n7', '--', '/bin/zsh', '-l']);
  });

  it('should name its scope apart from the harness’s while keeping the session id in it', async () => {
    // Arrange
    const { received, create } = build();

    // Act
    await create({ by: 'agent', sessionId: 'ses-1' });

    // Assert — `sessionOfScope` reads the session id out of the name, so the watcher still attributes it
    should(launched(received[0] as string[])).containEql('--unit=ferretry-agent-ses-1-ta1b2c3d4.scope');
  });
});

describe('a terminal the owner opens', () => {
  it('should stay outside the limits when a person or the host opened it', async () => {
    // Arrange
    const human = build();
    const local = build();
    const unrecorded = build();

    // Act
    await human.create({ by: 'human', deviceId: 'dev-1' });
    await local.create({ by: 'local' });
    await unrecorded.create();

    // Assert
    for (const { received } of [human, local, unrecorded])
      should(launched(received[0] as string[])).deepEqual(['/bin/zsh', '-l']);
  });
});
