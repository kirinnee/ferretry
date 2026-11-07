import { describe, it } from 'bun:test';
import type { Clock } from '@ferretry/kernel/contract';
import should from 'should';
import { SecretUseRequestSchema } from '../../../../contract/index.ts';
import {
  ChildEnvironments,
  NO_RECIPES,
  SecretDirectory,
  SecretUseError,
  SecretUseService,
  SecretVault,
  UnknownSecretError,
  type SecretChildOutcome,
  type SecretChildRunner,
  type SecretChildSpec,
  type SecretRecipes,
} from '../../../../daemon/lib/secrets/index.ts';
import { EchoSecretChildRunner, FakeSecretCipher, MemorySecretDocuments } from '../support.ts';
import { combinedValues, SecretRedactor } from '../../../../daemon/lib/secrets/redaction.ts';
import { EphemeralAwareRedactor } from '../../../../daemon/lib/inputs/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../../daemon/lib/inputs/ephemeral-values.ts';

const CLOCK = { now: () => '2026-01-01T00:00:00.000Z' } as unknown as Clock;
/** The Vault's handle table; the echo runner opens each child's environment with it, as the kernel's spawn does. */
const ENVS = new ChildEnvironments();
const useService = (vault: SecretVault, runner: SecretChildRunner, recipes?: SecretRecipes): SecretUseService =>
  new SecretUseService(vault, runner, ENVS, recipes);
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
  it('S10 I102 I126 masks an original cut prefix before a contained typed value rewrites it', async () => {
    const vault = await vaultHolding({ TOKEN: 'prefix-fixture-secret-suffix' });
    const typed = new EphemeralValues({ now: () => 1 });
    typed.hold('fixture', 'fixture-secret', '!A0');
    const masks = new EphemeralAwareRedactor(new SecretRedactor(vault), typed);
    const runner: SecretChildRunner = {
      run: async () => ({
        outcome: 'exited',
        exitCode: 0,
        stdout: 'prefix-fixture-secret',
        stderr: 'prefix-fixture-secret\uFFFD',
        truncated: true,
      }),
    };
    const result = await new SecretUseService(vault, runner, ENVS, NO_RECIPES, masks).run(request());
    should(result.stdout).equal('[redacted]');
    should(result.stderr).equal('[redacted]');
  });

  it('S10 I126 masks a rotated injected value before a contributed substring rewrites it', async () => {
    const documents = new MemorySecretDocuments();
    const cipher = new FakeSecretCipher();
    const directory = new SecretDirectory(documents, cipher, CLOCK);
    const vault = new SecretVault(documents, cipher);
    const original = 'prefix-fixture-secret-suffix';
    await directory.put('TOKEN', original);
    const masks = new SecretRedactor(
      combinedValues(vault, {
        values: async () => new Map([['login:test:password', 'fixture-secret']]),
      }),
    );
    const runner: SecretChildRunner = {
      run: async () => {
        await directory.put('TOKEN', 'replacement-vault-value');
        return {
          outcome: 'exited',
          exitCode: 0,
          stdout: original,
          stderr: `${original} replacement-vault-value`,
          truncated: false,
        };
      },
    };
    const result = await new SecretUseService(vault, runner, ENVS, NO_RECIPES, masks).run(
      request({ secrets: ['TOKEN'] }),
    );
    should(result.stdout).equal('[redacted:TOKEN]');
    should(result.stderr).equal('[redacted:TOKEN] [redacted:TOKEN]');
  });

  it('S10 I126 shared masks cover cut output and preserve the injected vault snapshot across replacement', async () => {
    const documents = new MemorySecretDocuments();
    const cipher = new FakeSecretCipher();
    const directory = new SecretDirectory(documents, cipher, CLOCK);
    const vault = new SecretVault(documents, cipher);
    await directory.put('TOKEN', TOKEN);
    const masks = new SecretRedactor(
      combinedValues(vault, {
        values: async () => new Map([['MASK_ONLY', 'login-fixture-value']]),
      }),
    );
    const runner: SecretChildRunner = {
      run: async spec => {
        should(ENVS.open(spec.env)).deepEqual({ TOKEN });
        await directory.put('TOKEN', 'replacement-vault-value');
        return {
          outcome: 'exited',
          exitCode: 0,
          stdout: `${TOKEN} login-fixture-value`,
          stderr: 'before login-fixt',
          truncated: true,
        };
      },
    };
    const service = new SecretUseService(vault, runner, ENVS, NO_RECIPES, masks);
    const result = await service.run(request({ secrets: ['TOKEN'] }));
    should(result.stdout).equal('[redacted:TOKEN] [redacted:MASK_ONLY]');
    should(result.stderr).equal('before [redacted:MASK_ONLY]');
    await should(service.run(request({ secrets: ['MASK_ONLY'] }))).be.rejectedWith(UnknownSecretError);
  });

  it('S3 S5 put the value in the CHILD environment and nowhere else', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(ENVS, () => 'done');
    const service = useService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(runner.opened).deepEqual({ TOKEN });
    should(result.used).deepEqual(['TOKEN']);
    should(result.outcome).equal('exited');
  });

  it('S14 S27 scrub the value out of a command whose whole purpose is to print it', async () => {
    // Arrange — this is the attack a person will actually try: `-- sh -c 'echo $TOKEN'`.
    const runner = new EchoSecretChildRunner(ENVS, env => `${env.TOKEN ?? ''}\n`);
    const service = useService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request({ command: ['sh', '-c', 'echo $TOKEN'], secrets: ['TOKEN'] }));

    // Assert
    should(result.stdout).equal('[redacted:TOKEN]\n');
    should(result.stdout).not.containEql(TOKEN);
  });

  it('S14 scrub stderr as well as stdout', async () => {
    // Arrange
    const runner: SecretChildRunner = {
      run: async (spec: SecretChildSpec): Promise<SecretChildOutcome> => ({
        outcome: 'exited',
        exitCode: 1,
        stdout: '',
        stderr: `curl: failed with ${ENVS.open(spec.env)?.TOKEN ?? ''}`,
        truncated: false,
      }),
    };
    const service = useService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(result.stderr).equal('curl: failed with [redacted:TOKEN]');
    should(result.exitCode).equal(1);
  });

  it('S27 scrub a secret the caller did NOT name, if the child printed it anyway', async () => {
    // Arrange — redaction masks every value this daemon holds, not only the injected ones, because a
    // value can reach a child's output by a path nobody predicted.
    const runner = new EchoSecretChildRunner(ENVS, () => `leaked ${TOKEN}`);
    const service = useService(await vaultHolding({ TOKEN }), runner);

    // Act
    const result = await service.run(request());

    // Assert
    should(result.stdout).equal('leaked [redacted:TOKEN]');
  });

  it('S64 refuse a named secret this daemon does not hold, before spawning anything', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(ENVS);
    const service = useService(await vaultHolding({}), runner);

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
    const service = useService(await vaultHolding({}), new EchoSecretChildRunner(ENVS));

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
    const runner = new EchoSecretChildRunner(ENVS, () => '');
    const service = useService(await vaultHolding({ TOKEN }), runner, {
      read: async () => ({ AUTH: 'Bearer ${secret:TOKEN}' }),
    });

    // Act
    await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(runner.opened).deepEqual({ TOKEN, AUTH: `Bearer ${TOKEN}` });
  });

  it('S63 withhold a recipe naming a secret the caller did not ask for', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(ENVS, () => '');
    const service = useService(await vaultHolding({ TOKEN, OTHER: 'pw-abcdefghij' }), runner, {
      read: async () => ({ AUTH: 'Bearer ${secret:OTHER}' }),
    });

    // Act
    await service.run(request({ secrets: ['TOKEN'] }));

    // Assert — an operator's convenience must not widen the caller's request.
    should(runner.opened).deepEqual({ TOKEN });
  });

  it('should give a child exactly what it asked for when no recipes are configured', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(ENVS, () => '');
    const service = useService(await vaultHolding({ TOKEN }), runner, NO_RECIPES);

    // Act
    await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(runner.opened).deepEqual({ TOKEN });
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
    const result = await useService(await vaultHolding({}), runner).run(request());

    // Assert
    should(result.outcome).equal('timeout');
    should(result.exitCode).be.undefined();
    should(result.truncated).be.true();
  });

  it('should pass the caller timeout and the output ceiling to the child', async () => {
    // Arrange
    const runner = new EchoSecretChildRunner(ENVS, () => '');

    // Act
    await useService(await vaultHolding({}), runner).run(request({ timeoutMs: 1_234 }));

    // Assert
    should(runner.spec?.timeoutMs).equal(1_234);
    should(runner.spec?.maxOutputBytes).be.greaterThan(0);
  });
});

describe('a value the output limit cut in half', () => {
  /** A runner that hands back exactly what a capped read would have kept. */
  const cutAt = (stdout: string, truncated: boolean): SecretChildRunner => ({
    run: async (): Promise<SecretChildOutcome> => ({ outcome: 'exited', exitCode: 0, stdout, stderr: '', truncated }),
  });

  it('should mask the beginning of a value the cut left at the very end', async () => {
    // Arrange — the cap fell eight characters into the token, so no whole-value match can see it.
    const service = useService(await vaultHolding({ TOKEN }), cutAt(`key=${TOKEN.slice(0, 8)}`, true));

    // Act
    const result = await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(result.stdout).equal('key=[redacted:TOKEN]');
    should(result.stdout).not.containEql(TOKEN.slice(0, 8));
    should(result.truncated).be.true();
  });

  it('should mask a prefix hidden behind a character the byte cut split', async () => {
    // Arrange — a multi-byte character cut in half decodes as U+FFFD, which would shield what precedes it.
    const service = useService(await vaultHolding({ TOKEN: 'pässwörd-0123' }), cutAt('pw=p�', true));

    // Act
    const result = await service.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(result.stdout).equal('pw=[redacted:TOKEN]');
  });

  it('should leave the end of an output that was not cut, and of one with no partial value, alone', async () => {
    // Arrange — a whole output may end however its program chose; only a cut can split a value.
    const whole = useService(await vaultHolding({ TOKEN }), cutAt(`tail ${TOKEN.slice(0, 8)}`, false));
    const unrelated = useService(await vaultHolding({ TOKEN }), cutAt('nothing secret here�', true));

    // Act
    const wholeResult = await whole.run(request({ secrets: ['TOKEN'] }));
    const unrelatedResult = await unrelated.run(request({ secrets: ['TOKEN'] }));

    // Assert
    should(wholeResult.stdout).equal(`tail ${TOKEN.slice(0, 8)}`);
    should(unrelatedResult.stdout).equal('nothing secret here�');
  });
});
