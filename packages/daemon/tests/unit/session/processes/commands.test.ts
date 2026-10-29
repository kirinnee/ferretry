import { describe, it } from 'bun:test';
import should from 'should';
import {
  claudeTaskId,
  commandLabel,
  liveOutputAvailability,
  outputFileOf,
  truncateCommand,
} from '../../../../src/lib/session/processes/commands.ts';

/**
 * WHAT A COMMAND LINE SAYS, AND WHERE ITS OUTPUT CAN BE READ — the pure half of the Processes tab.
 *
 * The wrapper strings are the REAL ones the two harnesses spawn, so a change to either harness's shape
 * fails here rather than silently turning every row's title into an unreadable `zsh -c source …`.
 */

const CLAUDE_WRAPPER = (command: string, suffix = ' < /dev/null'): string =>
  `/usr/bin/zsh -c source /home/kirin/.claude/shell-snapshots/snapshot-zsh-1761700000-ab12cd.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '${command}'${suffix} && pwd -P >| /tmp/claude-d9b0-cwd`;

describe('commandLabel', () => {
  it('should recover the command from Claude’s real zsh wrapper, un-quoting its single quotes', () => {
    // Arrange — `echo 'hi'` as the agent wrote it, spelled `'"'"'` inside the single-quoted eval.
    const argv = CLAUDE_WRAPPER(`for i in $(seq 1 3); do echo '"'"'hi'"'"'; done`);

    // Act
    const label = commandLabel(argv);

    // Assert
    should(label).equal("for i in $(seq 1 3); do echo 'hi'; done");
  });

  it('should recover the command when the wrapper carries no `< /dev/null`', () => {
    // Arrange
    const argv = CLAUDE_WRAPPER('bun test', '');

    // Act
    const label = commandLabel(argv);

    // Assert
    should(label).equal('bun test');
  });

  it("should un-quote the `'\\''` spelling of an embedded single quote too", () => {
    // Arrange
    const argv = CLAUDE_WRAPPER("echo '\\''x'\\''");

    // Act
    const label = commandLabel(argv);

    // Assert
    should(label).equal("echo 'x'");
  });

  it('should recover a multi-line command whole', () => {
    // Arrange
    const argv = CLAUDE_WRAPPER('cd /repo\nbun test\n');

    // Act
    const label = commandLabel(argv);

    // Assert
    should(label).equal('cd /repo\nbun test');
  });

  it('should give no label for a wrapper whose command is empty', () => {
    // Arrange
    const argv = CLAUDE_WRAPPER('   ');

    // Act
    const label = commandLabel(argv);

    // Assert
    should(label).be.undefined();
  });

  it('should recover the script from Codex’s `bash -lc`', () => {
    // Arrange
    const argv = 'bash -lc bun test';

    // Act
    const label = commandLabel(argv);

    // Assert
    should(label).equal('bun test');
  });

  it('should read a path-qualified or login-prefixed shell as the same wrapper', () => {
    // Arrange / Act
    const labels = ['/bin/bash -lc ls -la', '-zsh -c make build', 'sh -c echo hi'].map(commandLabel);

    // Assert
    should(labels).deepEqual(['ls -la', 'make build', 'echo hi']);
  });

  it('should give no label for a plain argv, a shell with no `-c`, or an empty script', () => {
    // Arrange / Act
    const labels = ['sleep 30', 'bun run dev --port 3000', 'bash script.sh', 'bash -c ', 'node -e console.log(1)'].map(
      commandLabel,
    );

    // Assert
    should(labels).deepEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('claudeTaskId', () => {
  it('should name the task from Claude’s `…/tasks/<id>.output` file', () => {
    // Arrange
    const path = '/tmp/claude-1000/-home-kirin-Workspace/7076bd0c-a891/tasks/bx2k9f1a3.output';

    // Act
    const id = claudeTaskId(path);

    // Assert
    should(id).equal('bx2k9f1a3');
  });

  it('should give none for any other file', () => {
    // Arrange / Act
    const ids = ['/tmp/build.log', '/tmp/x/tasks/a.b.output', '/tmp/x/tasks/.output', '/tmp/x/tasks/id.output.bak'].map(
      claudeTaskId,
    );

    // Assert
    should(ids).deepEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('outputFileOf', () => {
  it('should prefer stdout’s file, then stderr’s, and otherwise none', () => {
    // Arrange
    const out = { kind: 'file', path: '/tmp/out' } as const;
    const err = { kind: 'file', path: '/tmp/err' } as const;

    // Act / Assert
    should(outputFileOf(out, err)).equal('/tmp/out');
    should(outputFileOf({ kind: 'pipe' }, err)).equal('/tmp/err');
    should(outputFileOf({ kind: 'terminal', path: '/dev/pts/3' }, { kind: 'null' })).be.undefined();
    should(outputFileOf(undefined, undefined)).be.undefined();
  });
});

describe('liveOutputAvailability', () => {
  it('should read a regular file, from stdout or else stderr', () => {
    // Arrange / Act
    const fromStdout = liveOutputAvailability({ kind: 'file', path: '/tmp/a' }, { kind: 'pipe' });
    const fromStderr = liveOutputAvailability({ kind: 'pipe' }, { kind: 'file', path: '/tmp/b' });

    // Assert
    should(fromStdout).deepEqual({ source: 'file' });
    should(fromStderr).deepEqual({ source: 'file' });
  });

  it('should send a terminal reader to the Console', () => {
    // Arrange / Act
    const availability = liveOutputAvailability({ kind: 'terminal', path: '/dev/pts/3' }, undefined);

    // Assert
    should(availability).deepEqual({ source: 'none', reason: 'Writes to the terminal — see Console.' });
  });

  it('should refuse a pipe or a socket, because reading it would take the output from its reader', () => {
    // Arrange / Act
    const pipe = liveOutputAvailability({ kind: 'pipe' }, { kind: 'pipe' });
    const socket = liveOutputAvailability({ kind: 'socket' }, undefined);

    // Assert
    should(pipe.source).equal('none');
    should(pipe.reason).match(/another program/u);
    should(socket).deepEqual(pipe);
  });

  it('should say a /dev/null output is thrown away, and an unknown target is unsafe to read', () => {
    // Arrange / Act
    const dropped = liveOutputAvailability({ kind: 'null' }, undefined);
    const odd = liveOutputAvailability({ kind: 'other', description: 'a deleted file' }, undefined);

    // Assert
    should(dropped).deepEqual({ source: 'none', reason: 'Its output is thrown away (sent to /dev/null).' });
    should(odd).deepEqual({ source: 'none', reason: 'Its output goes somewhere that cannot be read safely.' });
  });

  it('should fall back to stderr’s target when stdout is not known', () => {
    // Arrange / Act
    const availability = liveOutputAvailability(undefined, { kind: 'terminal', path: '/dev/tty1' });

    // Assert
    should(availability.reason).match(/Console/u);
  });

  it('should name the macOS gap when neither stream is known', () => {
    // Arrange / Act
    const availability = liveOutputAvailability(undefined, undefined);

    // Assert
    should(availability).deepEqual({ source: 'none', reason: 'Reading output is not supported on macOS yet.' });
  });
});

describe('truncateCommand', () => {
  it('should leave a command within the limit untouched and cut a longer one with an ellipsis, saying so', () => {
    // Arrange / Act
    const kept = truncateCommand('abcde', 5);
    const cut = truncateCommand('abcdefgh', 5);

    // Assert
    should(kept).deepEqual({ text: 'abcde', truncated: false });
    should(cut).deepEqual({ text: 'abcd…', truncated: true });
  });
});
