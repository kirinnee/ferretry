import { describe, it } from 'bun:test';
import should from 'should';
import { ExecutableCodePrograms } from '../../../src/adapters/system/executable-code-programs.ts';

/**
 * A code program is proved from the file a process RUNS, and only one this account cannot replace: the echo-off
 * "Verification code:" exception rests on it (docs/input-requests.md, "One-time codes").
 */

const programs = (executable: string | undefined, replaceable: boolean) =>
  new ExecutableCodePrograms(
    async () => executable,
    async () => replaceable,
  );

describe('ExecutableCodePrograms', () => {
  it('should prove nothing outside Linux: a name ps shows on macOS is not proven to be the executable', async () => {
    // Act / Assert — a real pid of this very process, which on Linux would be readable.
    should(await ExecutableCodePrograms.forPlatform('darwin').codeProgram(process.pid)).be.false();
    should(await ExecutableCodePrograms.forPlatform('freebsd').codeProgram(process.pid)).be.false();
  });

  it('should prove ssh from a store path this account cannot replace', async () => {
    // Act / Assert
    should(await programs('/nix/store/abc-openssh-10.0p2/bin/ssh', false).codeProgram(4242)).be.true();
    should(await programs('/usr/bin/sftp', false).codeProgram(4242)).be.true();
  });

  it('should never prove a shell that renamed itself ssh: its executable is still the shell', async () => {
    // Arrange — `printf ssh > /proc/$$/comm` changes the name ps shows, never /proc/<pid>/exe.
    const renamed = programs('/nix/store/abc-bash-5.3/bin/bash', false);

    // Act / Assert
    should(await renamed.codeProgram(4242)).be.false();
  });

  it('should never prove a copy the ferret could have made or changed', async () => {
    // Act / Assert — `cp /bin/bash ~/bin/ssh`: the right name, in a folder this account owns.
    should(await programs('/home/kirin/bin/ssh', true).codeProgram(4242)).be.false();
  });

  it('should prove nothing it cannot read, a deleted file, a relative path or a bad pid', async () => {
    // Act / Assert
    should(await programs(undefined, false).codeProgram(4242)).be.false();
    should(await programs('/usr/bin/ssh (deleted)', false).codeProgram(4242)).be.false();
    should(await programs('ssh', false).codeProgram(4242)).be.false();
    should(await programs('/usr/bin/ssh', false).codeProgram(0)).be.false();
    should(
      await new ExecutableCodePrograms(
        async () => '/usr/bin/ssh',
        async () => {
          throw new Error('lstat failed');
        },
      ).codeProgram(4242),
    ).be.false();
  });
});
