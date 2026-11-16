import { describe, it } from 'bun:test';
import should from 'should';
import { claudeToolShellPayload, commandLabel } from '../../src/harness-command.ts';

/** The wrapper strings are the REAL ones the two harnesses spawn (Claude Code 2.1.317, Codex `bash -lc`). */

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

/** Claude Code 2.1.317's Bash tool shell, character for character; only the snapshot name and payload vary. */
const REAL_WRAPPER = (payload: string, tail = ' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd'): string =>
  "/usr/bin/zsh -c source /home/kirin/.ferretry/fleet/homes/h1/shell-snapshots/snapshot-zsh-1763000000-ab12cd.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '" +
  payload +
  "'" +
  tail;

describe('claudeToolShellPayload', () => {
  it('should recover the payload from the exact real wrapper', () => {
    should(claudeToolShellPayload(REAL_WRAPPER('ls -la'))).equal('ls -la');
  });

  it('should un-quote an embedded single quote and keep the payload’s own redirects', () => {
    should(claudeToolShellPayload(REAL_WRAPPER(`echo '"'"'x'"'"' > out.txt`))).equal("echo 'x' > out.txt");
  });

  it('should accept a wrapper with no `< /dev/null`', () => {
    should(claudeToolShellPayload(REAL_WRAPPER('bun test', ' && pwd -P >| /tmp/claude-99ff-cwd'))).equal('bun test');
  });

  it('should refuse a wrapper that does not match to the character', () => {
    const cases = [
      REAL_WRAPPER('ls', ' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd; rm -rf x'),
      REAL_WRAPPER('ls', ' < /dev/null && rm -rf x && pwd -P >| /tmp/claude-99ff-cwd'),
      REAL_WRAPPER('ls', ' < /dev/null'),
      REAL_WRAPPER('ls').replace('source /home', 'source $(evil) /home'),
      REAL_WRAPPER('ls').replace('2>/dev/null || true &&', '2>/dev/null || true; rm x &&'),
      REAL_WRAPPER('ls').replace("'which'; ", "'which'; rm x; "),
      REAL_WRAPPER("a'; rm -rf /; echo '"),
      `timeout 5 ${REAL_WRAPPER('ls')}`,
      "zsh -c eval 'ls' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd",
      REAL_WRAPPER('   '),
    ];
    should(cases.map(claudeToolShellPayload)).deepEqual(cases.map(() => undefined));
  });
});
