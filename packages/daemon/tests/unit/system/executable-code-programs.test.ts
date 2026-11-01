import { describe, it } from 'bun:test';
import should from 'should';
import { ExecutableCodePrograms, ROOT_PROGRAM_FOLDERS } from '../../../src/adapters/system/executable-code-programs.ts';

/**
 * A code program is proved from the file a process RUNS, and only when that file is what a system folder this account
 * cannot change resolves the name to: the echo-off "Verification code:" exception rests on it (docs/input-requests.md,
 * "One-time codes").
 */

const SYSTEM_SSH = '/nix/store/aaa-openssh-10.0p2/bin/ssh';

/** A world where `/run/current-system/sw/bin/ssh` and `/usr/bin/sftp` are system links, and nothing else exists. */
const programs = (
  executable: string | undefined,
  options: { readonly replaceable?: (path: string) => boolean; readonly links?: Readonly<Record<string, string>> } = {},
) => {
  const links: Readonly<Record<string, string>> = options.links ?? {
    '/run/current-system/sw/bin/ssh': SYSTEM_SSH,
    '/usr/bin/sftp': '/usr/bin/sftp',
  };
  return new ExecutableCodePrograms(
    async () => executable,
    async path => links[path] ?? (Object.values(links).includes(path) ? path : undefined),
    async path => options.replaceable?.(path) ?? false,
  );
};

describe('ExecutableCodePrograms', () => {
  it('should prove nothing outside Linux: a name ps shows on macOS is not proven to be the executable', async () => {
    // Act / Assert — a real pid of this very process, which on Linux would be readable.
    should(await ExecutableCodePrograms.forPlatform('darwin').codeProgram(process.pid)).be.false();
    should(await ExecutableCodePrograms.forPlatform('freebsd').codeProgram(process.pid)).be.false();
  });

  it('should prove ssh the system folder resolves to, and sftp in /usr/bin', async () => {
    // Act / Assert
    should(await programs(SYSTEM_SSH).codeProgram(4242)).be.true();
    should(await programs('/usr/bin/sftp').codeProgram(4242)).be.true();
    should(ROOT_PROGRAM_FOLDERS).containEql('/run/current-system/sw/bin');
  });

  it('should name the program it proved, only among the names asked for', async () => {
    // Act / Assert
    should(await programs(SYSTEM_SSH).provenRootProgram(4242, new Set(['ssh']))).equal('ssh');
    should(await programs(SYSTEM_SSH).provenRootProgram(4242, new Set(['sudo']))).be.undefined();
    should(await programs('/usr/bin/sftp').provenRootProgram(4242, new Set())).be.undefined();
    should(await programs('/usr/bin/sftp').provenRootProgram(4242, name => name.startsWith('sf'))).equal('sftp');
    should(await programs('/usr/bin/sftp').provenRootProgram(4242, () => false)).be.undefined();
    should(await programs('/nix/store/bbb-ssh/bin/ssh').provenRootProgram(4242, new Set(['ssh']))).be.undefined();
  });

  it('should never prove a store path no system folder resolves to: anyone may add one to the store', async () => {
    // Arrange — `nix-store --add` of a bash copy at <hash>/bin/ssh: root-owned and read-only, but nobody's ssh.
    const added = programs('/nix/store/bbb-ssh/bin/ssh');

    // Act / Assert
    should(await added.codeProgram(4242)).be.false();
  });

  it('should never prove a shell that renamed itself ssh: its executable is still the shell', async () => {
    // Act / Assert — `printf ssh > /proc/$$/comm` changes the name ps shows, never /proc/<pid>/exe.
    should(await programs('/nix/store/ccc-bash-5.3/bin/bash').codeProgram(4242)).be.false();
  });

  it('should never prove a copy in a user folder, nor a system folder this account can change', async () => {
    // Act / Assert — `cp /bin/bash ~/bin/ssh`; and /usr/local/bin owned by this account.
    should(await programs('/home/kirin/bin/ssh').codeProgram(4242)).be.false();
    should(
      await programs('/usr/local/bin/ssh', {
        links: { '/usr/local/bin/ssh': '/usr/local/bin/ssh' },
        replaceable: path => path.startsWith('/usr/local/'),
      }).codeProgram(4242),
    ).be.false();
  });

  it('should prove nothing it cannot read, a deleted file, a relative path or a bad pid', async () => {
    // Act / Assert
    should(await programs(undefined).codeProgram(4242)).be.false();
    should(await programs(`${SYSTEM_SSH} (deleted)`).codeProgram(4242)).be.false();
    should(await programs('ssh').codeProgram(4242)).be.false();
    should(await programs(SYSTEM_SSH).codeProgram(0)).be.false();
    should(
      await programs(SYSTEM_SSH, {
        replaceable: () => {
          throw new Error('lstat failed');
        },
      }).codeProgram(4242),
    ).be.false();
  });
});
