import { describe, it } from 'bun:test';
import should from 'should';
import {
  launchGuardActive,
  RealHarnessRefusedError,
  realHarnessInstall,
  type TmuxCommandPort,
  TmuxController,
  type TmuxLaunch,
  type TmuxLaunchGuard,
} from '../../../src/lib/index.ts';

class RecordingTmux implements TmuxCommandPort {
  readonly received: string[][] = [];

  async execute(arguments_: readonly string[]) {
    this.received.push([...arguments_]);
    // `has-session` answers "absent" so a launch proceeds; everything else succeeds.
    return { code: arguments_[0] === 'has-session' ? 1 : 0, stdout: '', stderr: '' };
  }
}

describe('real harness installs', () => {
  it('should name the install of every real claude and codex layout', () => {
    // Arrange
    const real = [
      '/nix/store/r331x6dfyzn5k8mj74p16gqm3ba1aw4n-claude-code-2.1.281/bin/claude',
      '/nix/store/r331x6dfyzn5k8mj74p16gqm3ba1aw4n-claude-code-2.1.281/bin/.claude-unwrapped',
      '/nix/store/abcdefghijklmnopqrstuvwxyz012345-codex-0.130.0/bin/codex',
      '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      '/usr/lib/node_modules/@openai/codex/bin/codex.js',
      '/opt/claude/.claude-wrapped',
      '/home/someone/.local/share/claude/versions/2.1.281',
      '/home/someone/.claude/local/claude',
      '/opt/homebrew/Caskroom/claude-code/2.1.281/claude',
      '/opt/homebrew/Cellar/codex/0.130.0/bin/codex',
    ];

    // Act
    const actual = real.map(realHarnessInstall);

    // Assert
    should(actual).eql([
      'the Nix claude-code package',
      'the Nix claude-code package',
      'the Nix codex package',
      'the npm @anthropic-ai/claude-code package',
      'the npm @openai/codex package',
      'the Claude Code wrapper pair',
      'the Claude Code native installer',
      'the Claude Code local install',
      'a Homebrew harness install',
      'a Homebrew harness install',
    ]);
  });

  it('should pass every fake a test writes', () => {
    // Arrange
    const fakes = [
      '/tmp/fy-e2e-abc/harness-bin/claude',
      '/tmp/fy-e2e-abc/tools/codex',
      '/home/someone/repo/scripts/test/fake-harness.ts',
      '/tmp/fy-e2e-abc/state/fleet/bin/claude-default',
      '/nix/store/abcdefghijklmnopqrstuvwxyz012345-codex-helpers/bin/codex',
    ];

    // Act
    const actual = fakes.map(realHarnessInstall);

    // Assert
    should(actual).eql([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('when the launch guard is on', () => {
  it('should turn on for the runner flag or a state home under a temporary root, and only then', () => {
    // Act
    const actual = {
      flagged: launchGuardActive({ flag: '1', home: '/home/someone/.ferretry', temporaryRoots: ['/tmp'] }),
      temporary: launchGuardActive({ flag: undefined, home: '/tmp/fy-e2e-1/state', temporaryRoots: ['/tmp'] }),
      rootItself: launchGuardActive({ flag: undefined, home: '/tmp', temporaryRoots: ['/tmp/'] }),
      lookalike: launchGuardActive({ flag: undefined, home: '/tmpfoo/state', temporaryRoots: ['/tmp'] }),
      blankRoot: launchGuardActive({ flag: '0', home: '/home/someone/.ferretry', temporaryRoots: [''] }),
      owner: launchGuardActive({ flag: undefined, home: '/home/someone/.ferretry', temporaryRoots: ['/tmp'] }),
    };

    // Assert
    should(actual).eql({
      flagged: true,
      temporary: true,
      rootItself: true,
      lookalike: false,
      blankRoot: false,
      owner: false,
    });
  });
});

describe('a guarded tmux controller', () => {
  it('should create no pane when its guard refuses the launch', async () => {
    // Arrange
    const tmux = new RecordingTmux();
    const refusal = new RealHarnessRefusedError('claude', '/nix/store/x-claude-code-1/bin/claude', 'the Nix package');
    const seen: TmuxLaunch[] = [];
    const guard: TmuxLaunchGuard = {
      check: async launch => {
        seen.push(launch);
        throw refusal;
      },
    };
    const subject = new TmuxController(tmux, guard);
    const launch: TmuxLaunch = { session: 'work', cwd: '/tmp', command: ['claude-default'] };

    // Act
    const actual = await subject.launch(launch).catch((error: unknown) => error);

    // Assert
    should(actual).equal(refusal);
    should(seen).eql([launch]);
    should(tmux.received).eql([]);
    should(refusal.harness).equal('claude');
    should(refusal.name).equal('RealHarnessRefusedError');
    should(refusal.message).match(/test mode refused to launch a real harness: claude resolves to /);
    should(refusal.message).containEql('fake claude/codex first on PATH');
  });

  it('should launch exactly as before when its guard allows the launch', async () => {
    // Arrange
    const tmux = new RecordingTmux();
    const subject = new TmuxController(tmux, { check: async () => undefined });

    // Act
    await subject.launch({ session: 'work', cwd: '/tmp', command: ['agent'] });

    // Assert
    should(tmux.received.map(command => command[0])).eql(['has-session', 'new-session', 'set-option']);
  });
});
