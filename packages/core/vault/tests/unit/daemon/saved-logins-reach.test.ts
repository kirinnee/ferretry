import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { InputSavedLogins, SAVED_LOGINS_KEY } from '../../../contract/index.ts';

/**
 * WHO CAN REACH A SAVED LOGIN'S VALUE. `input.saved:saved` is provided by Accounts alone and consumed by the Vault's own
 * input path alone: no route, command or agent tool can call its `fill` or `listing`, because nothing else names the
 * hook, its key or the class that answers it.
 */
const ROOT = join(import.meta.dir, '../../../../../..');

/** Every source file under `packages/` that is not a test, a dependency or generated. */
async function sources(): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  for await (const path of new Bun.Glob('packages/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    if (/(^|\/)(node_modules|tests|generated|dist)\//u.test(path)) continue;
    found.set(path, await readFile(join(ROOT, path), 'utf8'));
  }
  return found;
}

const naming = (all: ReadonlyMap<string, string>, ...needles: readonly string[]): readonly string[] =>
  [...all]
    .filter(([, text]) => needles.some(needle => text.includes(needle)))
    .map(([path]) => path)
    .sort();

describe('the saved-login hook’s reach', () => {
  it('should be provided by Accounts alone and offered by the Vault alone', () => {
    should(InputSavedLogins.name).equal('input.saved');
    should(InputSavedLogins.mode).equal('provide');
    should(InputSavedLogins.takers).eql(['accounts']);
    should(SAVED_LOGINS_KEY).equal('saved');
  });

  it('should be named only by the Vault’s contract, manifest and input path and by Accounts’ manifest and boot', async () => {
    const all = await sources();

    should(naming(all, 'InputSavedLogins', "'input.saved", 'SAVED_LOGINS_KEY')).eql([
      'packages/core/vault/contract/saved-logins.ts',
      'packages/core/vault/daemon/inputs.ts',
      'packages/core/vault/manifest.ts',
      'packages/plugins/accounts/daemon/index.ts',
      'packages/plugins/accounts/manifest.ts',
    ]);
  });

  it('should be answered by one class that no route, tool or command holds', async () => {
    const all = await sources();

    should(naming(all, 'AccountsSavedLogins')).eql([
      'packages/plugins/accounts/daemon/index.ts',
      'packages/plugins/accounts/daemon/lib/saved-logins-hook.ts',
    ]);
    should(naming(all, 'SavedLoginsThroughHook')).eql([
      'packages/core/vault/daemon/adapters/inputs/saved-logins.ts',
      'packages/core/vault/daemon/inputs.ts',
    ]);
  });
});
