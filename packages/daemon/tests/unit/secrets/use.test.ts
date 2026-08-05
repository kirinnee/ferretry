import { describe, it } from 'bun:test';
import should from 'should';
import { SecretUseRequestSchema } from '@ferretry/protocol';
import {
  NO_RECIPES,
  SecretDirectory,
  SecretUseError,
  SecretUseService,
  SecretVault,
  UnknownSecretError,
  type SecretChildOutcome,
  type SecretChildRunner,
  type SecretChildSpec,
} from '../../../src/lib/secrets/index.ts';
import { EchoSecretChildRunner, FakeSecretCipher, MemorySecretDocuments } from '../runtime/mounts/support.ts';

const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' };
const TOKEN = 'sk-live-0123456789';

async function vaultHolding(entries: Record<string, string>): Promise<SecretVault> {
  const documents = new MemorySecretDocuments();
  const cipher = new FakeSecretCipher();
  const directory = new SecretDirectory(documents, cipher, CLOCK);
  for (const [name, value] of Object.entries(entries)) await directory.put(name, value);
  return new SecretVault(documents, cipher);
}

function request(overrides: Record<string, unknown> = {}) {
  return SecretUseRequestSchema.parse({ command: ['env'], cwd: '/srv/app', ...overrides });
}

describe('use without read', () => {
  it('should put the value in the CHILD environment and nowhere else', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(() => 'done');
    const service = new SecretUseService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(runner.spec?.env).deepEqual({ TOKEN });
    should(result.used).deepEqual(['TOKEN']);
    should(result.outcome).equal('exited');
  });

  it('should scrub the value out of a command whose whole purpose is to print it', async () => {
    // Arrange — this is the attack a person will actually try: `-- sh -c 'echo $TOKEN'`.
    const runner = new EchoSecretChildRunner(spec => `${spec.env.TOKEN ?? ''}\n`);
    const service = new SecretUseService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request({ command: ['sh', '-c', 'echo $TOKEN'], secrets: ['TOKEN'] }));

    // Assert
    should(result.stdout).equal('[redacted:TOKEN]\n');
    should(result.stdout).not.containEql(TOKEN);
  });

  it('should scrub stderr as well as stdout', async () => {
    // Arrange
    const runner: SecretChildRunner = {
      run: async (spec: SecretChildSpec): Promise<SecretChildOutcome> => ({
        outcome: 'exited',
        exitCode: 1,
        stdout: '',
        stderr: `curl: failed with ${spec.env.TOKEN ?? ''}`,
        truncated: false,
      }),
    };
    const service = new SecretUseService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(result.stderr).equal('curl: failed with [redacted:TOKEN]');
    should(result.exitCode).equal(1);
  });

  it('should scrub a secret the caller did NOT name, if the child printed it anyway', async () => {
    // Arrange — redaction masks every value this daemon holds, not only the injected ones, because a
    // value can reach a child's output by a path nobody predicted.
    const runner = new EchoSecretChildRunner(() => `leaked ${TOKEN}`);
    const service = new SecretUseService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request());

    // Assert
    should(result.stdout).equal('leaked [redacted:TOKEN]');
  });

  it('should refuse a named secret this daemon does not hold, before spawning anything', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner();
    const service = new SecretUseService(await vaultHolding({}), runner);

    // Act / Assert
    await service.run(request({ secrets: ['ABSENT'] })).then(
      () => should.fail('', '', 'an unresolvable reference must refuse'),
      (error: unknown) => {
        should(error).be.instanceof(UnknownSecretError);
        should(runner.spec).be.undefined();
      },
    );
  });

  it('should refuse a relative working directory rather than run somewhere the caller did not name', async () => {
    // Arrange
    const service = new SecretUseService(await vaultHolding({}), new EchoSecretChildRunner());

    // Act / Assert
    await service.run(SecretUseRequestSchema.parse({ command: ['env'], cwd: 'relative/path' })).then(
      () => should.fail('', '', 'a relative cwd must refuse'),
      (error: unknown) => {
        should(error).be.instanceof(SecretUseError);
        should((error as SecretUseError).refusal).equal('invalid_cwd');
      },
    );
  });

  it('should give the child a recipe it earned', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(() => '');
    const service = new SecretUseService(await vaultHolding({ TOKEN }), runner, {
      read: async () => ({ AUTH: 'Bearer ${secret:TOKEN}' }),
    });

    // Act
    await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(runner.spec?.env).deepEqual({ TOKEN, AUTH: `Bearer ${TOKEN}` });
  });

  it('should withhold a recipe naming a secret the caller did not ask for', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(() => '');
    const service = new SecretUseService(await vaultHolding({ TOKEN, OTHER: 'pw-abcdefghij' }), runner, {
      read: async () => ({ AUTH: 'Bearer ${secret:OTHER}' }),
    });

    // Act
    await service.run(request({ secrets: ['TOKEN'] }));

    // Assert — an operator's convenience must not widen the caller's request.
    should(runner.spec?.env).deepEqual({ TOKEN });
  });

  it('should give a child exactly what it asked for when no recipes are configured', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(() => '');
    const service = new SecretUseService(await vaultHolding({ TOKEN }), runner, NO_RECIPES);

    // Act
    await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(runner.spec?.env).deepEqual({ TOKEN });
  });

  it('should report a timeout as a timeout, with no invented exit code', async () => {
    // Arrange
    const runner: SecretChildRunner = {
      run: async (): Promise<SecretChildOutcome> => ({
        outcome: 'timeout',
        stdout: 'partial',
        stderr: '',
        truncated: true,
      }),
    };

    // Act
    const result = await new SecretUseService(await vaultHolding({}), runner).run(request());

    // Assert
    should(result.outcome).equal('timeout');
    should(result.exitCode).be.undefined();
    should(result.truncated).be.true();
  });

  it('should pass the caller timeout and the output ceiling to the child', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(() => '');

    // Act
    await new SecretUseService(await vaultHolding({}), runner).run(request({ timeoutMs: 1_234 }));

    // Assert
    should(runner.spec?.timeoutMs).equal(1_234);
    should(runner.spec?.maxOutputBytes).be.greaterThan(0);
  });
});
