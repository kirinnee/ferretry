import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretUseRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  BunSecretChildRunner,
  ConfigSecretRecipes,
  FileSecretDocumentStore,
  FileSecretKey,
  WebCryptoSecretCipher,
} from '../../../src/adapters/secrets/index.ts';
import {
  createFoundationPaths,
  resolveStateHome,
  SecretDirectory,
  SecretUseService,
  SecretVault,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * Use-without-read against a REAL child.
 *
 * THE CASE THAT MATTERS is `echo $TOKEN`: a command whose entire purpose is to print the secret. The
 * caller receives a mask, and the child genuinely held the value — so this proves a scrub rather
 * than an omission.
 *
 * The other load-bearing case is the environment allowlist. This daemon loads its own configured
 * secrets file into its own environment at boot, so a child that inherited everything would receive
 * credentials nobody asked for and the vault has no record of — which redaction would not even know
 * to mask.
 */

const TOKEN = 'sk-live-super-secret-value-0123456789';
const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' };

async function service(
  label: string,
  recipes: Readonly<Record<string, string>> = {},
  inherited: Readonly<Record<string, string | undefined>> = { ...process.env },
): Promise<SecretUseService> {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  await files.ensureDirectory(paths.state, 0o700);
  await files.ensureDirectory(paths.temporary, 0o700);
  const documents = new FileSecretDocumentStore(paths, files);
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(documents.keyFile, files));
  await new SecretDirectory(documents, cipher, CLOCK).put('TOKEN', TOKEN);
  return new SecretUseService(
    new SecretVault(documents, cipher),
    new BunSecretChildRunner(() => inherited),
    new ConfigSecretRecipes(async () => recipes),
  );
}

function request(overrides: Record<string, unknown>) {
  return SecretUseRequestSchema.parse({ cwd: '/tmp', timeoutMs: 20_000, ...overrides });
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('a real child holding a secret', () => {
  it('should mask the value when the command exists only to print it', async () => {
    // Arrange
    const uses = await service('use-echo');

    // Act
    const result = await uses.run(request({ command: ['sh', '-c', 'echo "$TOKEN"'], secrets: ['TOKEN'] }));

    // Assert — the child really printed the credential, and the caller gets a mask.
    should(result.outcome).equal('exited');
    should(result.exitCode).equal(0);
    should(result.stdout).equal('[redacted:TOKEN]\n');
    should(result.stdout).not.containEql(TOKEN);
  });

  it('should mask it out of `env` too, which prints the whole environment', async () => {
    // Arrange
    const uses = await service('use-env');

    // Act
    const result = await uses.run(request({ command: ['env'], secrets: ['TOKEN'] }));

    // Assert
    should(result.stdout).containEql('TOKEN=[redacted:TOKEN]');
    should(result.stdout).not.containEql(TOKEN);
  });

  it('should mask it out of stderr', async () => {
    // Arrange
    const uses = await service('use-stderr');

    // Act
    const result = await uses.run(request({ command: ['sh', '-c', 'echo "$TOKEN" >&2'], secrets: ['TOKEN'] }));

    // Assert
    should(result.stderr).equal('[redacted:TOKEN]\n');
  });

  it('should NOT hand the child the rest of this daemon‘s environment', async () => {
    // Arrange — a variable the daemon holds that no caller asked for. It stands in for the values
    // `loadDaemonSecrets` puts in this process at boot.
    const uses = await service('use-allowlist', {}, { PATH: process.env.PATH, DAEMON_ONLY_SECRET: 'must-not-travel' });

    // Act
    const result = await uses.run(request({ command: ['env'], secrets: ['TOKEN'] }));

    // Assert
    should(result.stdout).not.containEql('DAEMON_ONLY_SECRET');
    should(result.stdout).containEql('PATH=');
  });

  it('should compose a value through an operator recipe the caller earned', async () => {
    // Arrange
    const uses = await service('use-recipe', { AUTH: 'Bearer ${secret:TOKEN}' });

    // Act
    const result = await uses.run(request({ command: ['sh', '-c', 'echo "${AUTH%% *}"'], secrets: ['TOKEN'] }));

    // Assert — the header really was built from the value; only its scheme survives the print.
    should(result.stdout).equal('Bearer\n');
  });

  it('should report a non-zero exit as itself', async () => {
    // Arrange
    const uses = await service('use-exit');

    // Act
    const result = await uses.run(request({ command: ['sh', '-c', 'exit 3'] }));

    // Assert
    should(result.outcome).equal('exited');
    should(result.exitCode).equal(3);
  });

  it('should kill a child that overruns and report a timeout, not an exit code', async () => {
    // Arrange
    const uses = await service('use-timeout');

    // Act
    const result = await uses.run(request({ command: ['sh', '-c', 'sleep 30'], timeoutMs: 300 }));

    // Assert — naming an exit status would claim the program chose to end that way.
    should(result.outcome).equal('timeout');
    should(result.exitCode).be.undefined();
  });

  it('should report a program that does not exist as a spawn failure, quoting nothing', async () => {
    // Arrange
    const uses = await service('use-missing-program');

    // Act
    const result = await uses.run(request({ command: ['/nonexistent/program-fy-test'], secrets: ['TOKEN'] }));

    // Assert — argv is the caller's, so a diagnostic that echoed it would echo anything put there.
    should(result.outcome).equal('spawn_failed');
    should(result.stdout).equal('');
    should(result.stderr).equal('');
  });

  it('should truncate a runaway stream and say that it did', async () => {
    // Arrange
    const uses = await service('use-truncate');

    // Act — more than the 256 KiB ceiling.
    const result = await uses.run(request({ command: ['sh', '-c', 'yes 0123456789abcdef | head -c 400000'] }));

    // Assert
    should(result.truncated).be.true();
    should(result.stdout.length).be.belowOrEqual(256 * 1024);
  });

  it('should give the child no stdin, so a prompt can never hang the daemon', async () => {
    // Arrange
    const uses = await service('use-stdin');

    // Act
    const result = await uses.run(request({ command: ['sh', '-c', 'cat; echo done'] }));

    // Assert
    should(result.outcome).equal('exited');
    should(result.stdout).equal('done\n');
  });

  it('should refuse a named secret this daemon does not hold, spawning nothing', async () => {
    // Arrange
    const uses = await service('use-unknown');

    // Act / Assert
    await uses.run(request({ command: ['env'], secrets: ['ABSENT'] })).then(
      () => should.fail('', '', 'an unknown secret must refuse'),
      (error: unknown) => should((error as Error).message).match(/ABSENT/u),
    );
  });
});

describe('the operator recipe source', () => {
  it('should read the recipes and the references it implies from ONE source', async () => {
    // Arrange — one adapter serves both so the screen and the spawned child cannot disagree about
    // what the operator wrote.
    const recipes = { AUTH: 'Bearer ${secret:TOKEN}', PLAIN: 'literal' };
    const source = new ConfigSecretRecipes(async () => recipes);

    // Act
    const read = await source.read();
    const references = await source.references();

    // Assert
    should(read).deepEqual(recipes);
    should(references).deepEqual([{ name: 'TOKEN', origin: 'config/daemon.json → secretEnvironment.AUTH' }]);
  });

  it('should report no recipes and no references when the operator configured none', async () => {
    // Arrange
    const source = new ConfigSecretRecipes(async () => ({}));

    // Act / Assert
    should(await source.read()).deepEqual({});
    should(await source.references()).deepEqual([]);
  });
});

describe('the child runner, finding the program it runs', () => {
  /** A folder holding one program, `hello`, that prints `hi`. */
  async function folderWithProgram(label: string): Promise<{ folder: string; bin: string }> {
    const folder = await tempDirectory(label);
    const bin = join(folder, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'hello'), '#!/bin/sh\necho hi\n');
    await chmod(join(bin, 'hello'), 0o755);
    return { folder, bin };
  }
  const spec = (command: string[], cwd: string) => ({ command, cwd, env: {}, timeoutMs: 5_000, maxOutputBytes: 1_024 });

  it("should run the program it finds on the child's own PATH and name that very file", async () => {
    // Arrange
    const { folder, bin } = await folderWithProgram('runner-which');
    const runner = new BunSecretChildRunner(() => ({ PATH: bin }));

    // Act
    const result = await runner.run(spec(['hello'], folder));

    // Assert
    should(result).match({ outcome: 'exited', exitCode: 0, program: join(bin, 'hello'), stdout: 'hi\n' });
  });

  it('should resolve a program named by a path against the working folder', async () => {
    // Arrange
    const { folder, bin } = await folderWithProgram('runner-path');
    const runner = new BunSecretChildRunner(() => ({ PATH: '/nonexistent' }));

    // Act
    const result = await runner.run(spec(['./bin/hello'], folder));

    // Assert
    should(result).match({ outcome: 'exited', program: join(await realpath(bin), 'hello') });
  });

  it("should walk .. from the folder's real location, as the kernel does, never through a symlink", async () => {
    // Arrange — work/link points at real/sub; ../tools/hello is real/tools/hello, never work/tools/hello.
    const folder = await tempDirectory('runner-symlink');
    await mkdir(join(folder, 'real', 'sub'), { recursive: true });
    await mkdir(join(folder, 'real', 'tools'));
    await writeFile(join(folder, 'real', 'tools', 'hello'), '#!/bin/sh\necho real\n');
    await chmod(join(folder, 'real', 'tools', 'hello'), 0o755);
    await mkdir(join(folder, 'work'));
    await symlink(join(folder, 'real', 'sub'), join(folder, 'work', 'link'));
    const runner = new BunSecretChildRunner(() => ({ PATH: '/nonexistent' }));

    // Act
    const result = await runner.run(spec(['../tools/hello'], join(folder, 'work', 'link')));

    // Assert
    should(result).match({
      outcome: 'exited',
      stdout: 'real\n',
      program: join(await realpath(folder), 'real', 'tools', 'hello'),
    });
  });

  it('should say a program this account could swap is replaceable, and a system one is not', async () => {
    // Arrange
    const { folder, bin } = await folderWithProgram('runner-replaceable');
    const runner = new BunSecretChildRunner(() => ({ PATH: `${bin}:${process.env.PATH ?? ''}` }));

    // Act
    const own = await runner.run(spec(['hello'], folder));
    const system = await runner.run(spec(['sh', '-c', 'true'], folder));

    // Assert
    should(own.replaceable).be.true();
    should(system.replaceable).be.undefined();
  });

  it('should still call a program this account owns replaceable after it took away its own write bits', async () => {
    // Arrange — an owner can chmod its way back in, so 555 proves nothing.
    const { folder, bin } = await folderWithProgram('runner-chmod');
    await chmod(join(bin, 'hello'), 0o555);
    await chmod(bin, 0o555);
    const runner = new BunSecretChildRunner(() => ({ PATH: bin }));

    // Act
    const result = await runner.run(spec(['hello'], folder)).finally(async () => await chmod(bin, 0o755));

    // Assert
    should(result).match({ outcome: 'exited', replaceable: true });
  });

  it("should judge by who OWNS the path, so another account's program in a sticky or closed folder is not replaceable", async () => {
    // Arrange — the same file, as seen by an account that owns nothing on the way to it.
    const { folder, bin } = await folderWithProgram('runner-other-account');
    // Closed to others whatever this machine's umask is: a group-writable folder is replaceable, rightly.
    await chmod(bin, 0o755);
    const runner = new BunSecretChildRunner(
      () => ({ PATH: bin }),
      () => -1,
    );

    // Act
    const result = await runner.run(spec(['hello'], folder));

    // Assert
    should(result.outcome).equal('exited');
    should(result.replaceable).be.undefined();
  });

  it('should follow a link inside the program path on the disk itself, as the kernel does', async () => {
    // Arrange — x/link/../tools/hello is real/tools/hello, never x/tools/hello.
    const folder = await tempDirectory('runner-inner-link');
    await mkdir(join(folder, 'real', 'sub'), { recursive: true });
    await mkdir(join(folder, 'real', 'tools'));
    await writeFile(join(folder, 'real', 'tools', 'hello'), '#!/bin/sh\necho inner\n');
    await chmod(join(folder, 'real', 'tools', 'hello'), 0o755);
    await mkdir(join(folder, 'x'));
    await symlink(join(folder, 'real', 'sub'), join(folder, 'x', 'link'));
    const runner = new BunSecretChildRunner(() => ({ PATH: '/nonexistent' }));

    // Act
    const result = await runner.run(spec(['x/link/../tools/hello'], folder));

    // Assert
    should(result).match({
      outcome: 'exited',
      stdout: 'inner\n',
      program: join(await realpath(folder), 'real', 'tools', 'hello'),
    });
  });

  it('should keep the name of a program that is itself a link, as the kernel does, so a script sees its own name', async () => {
    // Arrange — bin/foo-start links to libexec/toolbox, which acts on the name it was started by.
    const folder = await tempDirectory('runner-link-name');
    await mkdir(join(folder, 'libexec'));
    await mkdir(join(folder, 'bin'));
    await writeFile(join(folder, 'libexec', 'toolbox'), '#!/bin/sh\necho "$0"\n');
    await chmod(join(folder, 'libexec', 'toolbox'), 0o755);
    await symlink(join(folder, 'libexec', 'toolbox'), join(folder, 'bin', 'foo-start'));
    const runner = new BunSecretChildRunner(() => ({ PATH: '/nonexistent' }));

    // Act
    const result = await runner.run(spec(['./bin/foo-start'], folder));

    // Assert
    const link = join(folder, 'bin', 'foo-start');
    should(result).match({ outcome: 'exited', stdout: `${link}\n`, program: link });
  });

  it('should report a name too long to look up as a spawn failure, not throw', async () => {
    // Arrange
    const { folder } = await folderWithProgram('runner-long');
    const runner = new BunSecretChildRunner();

    // Act
    const result = await runner.run(spec(['x'.repeat(5_000)], folder));

    // Assert
    should(result.outcome).equal('spawn_failed');
  });

  it('should report a bare name the PATH does not hold as a spawn failure, naming no program', async () => {
    // Arrange
    const { folder } = await folderWithProgram('runner-missing');
    const runner = new BunSecretChildRunner(() => ({ PATH: join(folder, 'empty') }));

    // Act
    const result = await runner.run(spec(['hello'], folder));

    // Assert
    should(result).eql({ outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false });
  });
});
