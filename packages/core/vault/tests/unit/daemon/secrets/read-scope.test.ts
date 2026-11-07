import { describe, it } from 'bun:test';
import type { ChildEnvironment, TargetKind } from '@ferretry/kernel/contract';
import should from 'should';
import { SecretNameSchema } from '../../../../contract/index.ts';
import {
  ChildEnvironments,
  CloneableSecretNameSchema,
  HoldRegistry,
  maskGrid,
  maskLines,
  SecretDirectory,
  SecretStoreError,
  VaultRedaction,
} from '../../../../daemon/lib/secrets/index.ts';

/**
 * The parts vault-a added around today's code: the kernel-bound `Redaction` (today's `SecretRedactor.batch` as one
 * read-scoped redactor), the `ChildEnvironment` handle table (lead decision 9) and the `OutputGuard` registry.
 */

const TOKEN = 'sk-live-0123456789';

/** A value source that counts its opens, or fails. */
function source(entries: Record<string, string> | Error) {
  let opens = 0;
  return {
    opens: () => opens,
    values: async () => {
      opens += 1;
      if (entries instanceof Error) throw entries;
      return new Map(Object.entries(entries));
    },
  };
}

describe('the read-scoped redaction', () => {
  it('S15 S18 an operator read is masked: a known value reads as [redacted:NAME]', async () => {
    // Arrange
    const redaction = new VaultRedaction(source({ TOKEN }));

    // Act
    const text = await redaction.read(scope => scope.text(`export TOKEN=${TOKEN}`));

    // Assert
    should(text).equal('export TOKEN=[redacted:TOKEN]');
  });

  it('S19 a vault that cannot be opened refuses the read rather than serve unmasked text', async () => {
    // Arrange
    const redaction = new VaultRedaction(source(new SecretStoreError('key_missing', 'gone')));
    let ran = false;

    // Act / Assert
    await redaction
      .read(scope => {
        ran = true;
        return scope.text(TOKEN);
      })
      .then(
        () => should.fail('', '', 'a damaged vault must refuse the read'),
        (error: unknown) => should((error as SecretStoreError).failure).equal('key_missing'),
      );
    should(ran).be.false();
  });

  it('S20 one read opens the vault once, and its scope is revoked when the read returns', async () => {
    // Arrange
    const values = source({ TOKEN });
    const redaction = new VaultRedaction(values);
    let kept: ((s: string) => string) | undefined;

    // Act
    const texts = await redaction.read(scope => {
      kept = scope.text;
      return [scope.text(TOKEN), scope.text(`a ${TOKEN}`), scope.text('nothing')];
    });

    // Assert — nothing is cached between reads, and a scope that escaped holds nothing.
    should(values.opens()).equal(1);
    should(texts).deepEqual(['[redacted:TOKEN]', 'a [redacted:TOKEN]', 'nothing']);
    should(() => kept?.(TOKEN)).throw();
  });

  it('should mask cells with same-width stars, including a value wrapped across rows', async () => {
    // Arrange — the token's first 8 characters end row one and the rest start row two.
    const grid = {
      columns: 12,
      rows: [
        [...`abcd${TOKEN.slice(0, 8)}`],
        [...`${TOKEN.slice(8)}x`],
      ],
    };

    // Act
    const masked = maskGrid(grid, [TOKEN]);

    // Assert — the shape is untouched and only the matched cells changed.
    should(masked.columns).equal(12);
    should(masked.rows[0]?.join('')).equal('abcd********');
    should(masked.rows[1]?.join('')).equal(`${'*'.repeat(TOKEN.length - 8)}x`);
  });

  it('should mask lines keeping each length, across a wrap', () => {
    const lines = maskLines([`one ${TOKEN.slice(0, 5)}`, `${TOKEN.slice(5)} two`], [TOKEN]);
    should(lines).deepEqual([`one ${'*'.repeat(5)}`, `${'*'.repeat(TOKEN.length - 5)} two`]);
  });
});

describe('child environments (lead decision 9)', () => {
  it('S5 a handle opens once to the values it was minted with, and says only its variable names', () => {
    // Arrange
    const table = new ChildEnvironments();
    const handle = table.mint({ TOKEN, PATH: '/usr/bin' });

    // Act
    const first = table.open(handle);
    const second = table.open(handle);

    // Assert — the values reach the kernel's spawn once and are never in the handle's JSON or fields.
    should(first).deepEqual({ TOKEN, PATH: '/usr/bin' });
    should(second).be.undefined();
    should(handle.names).deepEqual(['PATH', 'TOKEN']);
    should(JSON.stringify(handle)).not.containEql(TOKEN);
  });

  it('should refuse to open a handle another table minted, or a forged one', () => {
    const table = new ChildEnvironments();
    const other = new ChildEnvironments().mint({ TOKEN });
    should(table.open(other)).be.undefined();
    should(table.open({ names: ['TOKEN'] } as unknown as ChildEnvironment)).be.undefined();
  });
});

describe('what the types refuse', () => {
  it('S6 S7 S157 the management surface has no method that hands back a value', () => {
    // Assert — the directory a route holds can list, write and remove; nothing on it opens ciphertext.
    const methods = Object.getOwnPropertyNames(SecretDirectory.prototype).filter(name => name !== 'constructor');
    should(methods.filter(name => !name.startsWith('#')).sort()).deepEqual(
      ['document', 'inTurn', 'list', 'put', 'putIf', 'putMissing', 'remove', 'write'].sort(),
    );
  });

  it('S12 S62 `${secret:…}` names only a stored secret: an account seal key is not a secret name', () => {
    should(SecretNameSchema.safeParse('login:GITHUB:password').success).be.false();
    should(SecretNameSchema.safeParse('GITHUB_TOKEN').success).be.true();
  });

  it("S143 S144 S145 a copy's names cannot hold an MCP sign-in token", () => {
    should(CloneableSecretNameSchema.safeParse('MCP_LINEAR_0123456789ABCDEF_ACCESS').success).be.false();
    should(CloneableSecretNameSchema.safeParse('OPENAI_API_KEY').success).be.true();
  });
});

describe('the output guard', () => {
  const pane = { kind: 'terminal' as TargetKind, key: 'dev' };
  const other = { kind: 'terminal' as TargetKind, key: 'app' };

  it('should withhold a body stamped before a hold began on its target, and only on its target', () => {
    // Arrange
    const guard = new HoldRegistry();
    const stamped = guard.stamp([pane]);
    const elsewhere = guard.stamp([other]);

    // Act
    guard.moved(pane);

    // Assert
    should(guard.stillShowable(stamped)).be.false();
    should(guard.stillShowable(elsewhere)).be.true();
    should(guard.stillShowable(guard.stamp([pane]))).be.true();
  });

  it('should read a stamp it cannot check as not showable', () => {
    const guard = new HoldRegistry();
    should(guard.stillShowable({ generation: 0, targets: null as never })).be.false();
  });
});
