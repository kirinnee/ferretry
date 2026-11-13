/**
 * `kernel.secrets.resolve` for a secret the plugin MINTS (`permissions.mintedSecrets`): a plugin that put a value in the
 * Vault under a name of its own pattern (MCP's sign-in access tokens) may spend that value, as one spends what one made.
 * The three-step rule is unchanged for every other name: declared, named by the plugin's own configuration, known to
 * the Vault. A minted name is not in anyone's configuration, so the second step does not apply to it.
 */
import { describe, expect, test } from 'bun:test';
import { OwnSecret } from '../../../contract/secrets.ts';
import { ownSecretsPort } from '../../../host/secrets.ts';

const MINTED = 'MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS';
const ACCESS = 'MCP_LINEAR_0123456789ABCDEF_ACCESS';
const VAULT: Readonly<Record<string, string>> = { [ACCESS]: 'tok-minted', OTHERS_KEY: 'tok-other', NAMED: 'tok-named' };

const port = (minted: readonly string[] = [MINTED]) =>
  ownSecretsPort(
    ['NAMED'],
    () => new Set<string>(),
    () => ({ resolve: async name => VAULT[name] }),
    undefined,
    minted,
  );

describe('resolving a secret the plugin mints', () => {
  test('a name its minted pattern matches resolves with no reference in any configuration', async () => {
    const found = await port().resolve(ACCESS);

    expect(found).toBeInstanceOf(OwnSecret);
    expect((found as OwnSecret).reveal()).toBe('tok-minted');
  });

  test('a plugin that mints nothing is refused the same name, as before', async () => {
    expect(await port([]).resolve(ACCESS)).toEqual({ refused: 'not_declared' });
  });

  test('a name outside the pattern is refused, whatever else the Vault holds', async () => {
    expect(await port().resolve('OTHERS_KEY')).toEqual({ refused: 'not_declared' });
  });

  test('the pattern matches the whole name, never a part of it', async () => {
    expect(await port().resolve(`X_${ACCESS}`)).toEqual({ refused: 'not_declared' });
    expect(await port().resolve(`${ACCESS}_X`)).toEqual({ refused: 'not_declared' });
  });

  test('a declared name still needs its own configuration to name it', async () => {
    expect(await port().resolve('NAMED')).toEqual({ refused: 'not_configured' });
  });

  test('a minted name the Vault does not hold is unknown, not declared away', async () => {
    expect(await port().resolve('MCP_LINEAR_FFFFFFFFFFFFFFFF_ACCESS')).toEqual({ refused: 'unknown' });
  });
});
