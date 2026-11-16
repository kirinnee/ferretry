import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLAUDE_DANGEROUS_RM_HOOK_COMMAND,
  CLAUDE_DANGEROUS_RM_HOOKS,
  CLAUDE_DANGEROUS_RM_REASON,
} from '../../../daemon/lib/harness/dangerous-rm-hook.ts';

/**
 * O14: a Bash call Claude would stop on its "Dangerous rm operation detected" prompt is denied up front, with the reason.
 * The hook is run for real (`sh -c`), over the JSON Claude hands a `PreToolUse` hook.
 */

/** What the hook prints and its exit code, for one Bash command. */
async function run(command: string): Promise<{ readonly code: number; readonly out: string }> {
  const child = Bun.spawn(['sh', '-c', CLAUDE_DANGEROUS_RM_HOOK_COMMAND], {
    env: { PATH: '/usr/bin:/bin' },
    // A Buffer, not a Blob: see launch.test.ts.
    stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command } })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  return { code, out: await new Response(child.stdout).text() };
}

const DENIED = [
  'rm -rf "$X"',
  'rm -r -f "$A"',
  'rm -rf $(find . -name build)',
  'rm -rf `pwd`',
  'cd out && rm -rf ${DIR}/y',
  'sudo rm -rf $HOME',
  'echo hi\nrm -rf "$X"',
  'bash -c "rm -rf $T"',
  "sh -c 'rm /tmp/a'",
  'if true; then rmdir "$D"; fi',
];
const ALLOWED = [
  'rm -rf /tmp/build',
  'rm ./out/file.txt',
  'rm -f ./out/$name',
  'git rm "$f"',
  'docker rm $id',
  'confirm $x',
  'ls -la "$HOME"',
  'echo "hello"',
  'bun run test',
];

describe('the dangerous-rm hook', () => {
  for (const command of DENIED) {
    it(`should deny ${JSON.stringify(command)} with the reason`, async () => {
      // Act
      const { code, out } = await run(command);

      // Assert
      should(code).equal(0);
      should(JSON.parse(out)).eql({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: CLAUDE_DANGEROUS_RM_REASON,
        },
      });
    });
  }

  for (const command of ALLOWED) {
    it(`should say nothing about ${JSON.stringify(command)}`, async () => {
      // Act
      const { code, out } = await run(command);

      // Assert
      should(code).equal(0);
      should(out).equal('');
    });
  }

  it('should name the reason the owner asked for, and be a Bash PreToolUse hook only', () => {
    // Assert
    should(CLAUDE_DANGEROUS_RM_REASON).equal(
      'use explicit absolute rm paths; never "$VAR", a $(cmd) variable or rm inside bash -c',
    );
    should(Object.keys(CLAUDE_DANGEROUS_RM_HOOKS)).eql(['PreToolUse']);
    should(CLAUDE_DANGEROUS_RM_HOOKS.PreToolUse.map(entry => entry.matcher)).eql(['Bash']);
  });

  it('should fail open: exit 0 and print nothing when its input is not JSON or is empty', async () => {
    // Act
    const child = Bun.spawn(['sh', '-c', CLAUDE_DANGEROUS_RM_HOOK_COMMAND], {
      env: { PATH: '/usr/bin:/bin' },
      stdin: Buffer.from(''),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Assert
    should(await child.exited).equal(0);
    should(await new Response(child.stdout).text()).equal('');
  });
});
