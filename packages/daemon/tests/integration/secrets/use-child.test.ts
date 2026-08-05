import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { SecretUseRequestSchema } from '@ferretry/protocol';
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
