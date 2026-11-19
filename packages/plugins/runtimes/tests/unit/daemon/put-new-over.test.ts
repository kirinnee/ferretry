import { describe, expect, it } from 'bun:test';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { putNewOver } from '../../../daemon/host-assembly.ts';
import type { Permissions } from '@ferretry/kernel/manifest';
import manifest from '../../../manifest.ts';

const SENTINEL = 'sk-ant-never-shown-0f9c';

describe('putNewOver: an import adds a key and never replaces one', () => {
  it('files a name the Vault does not hold', async () => {
    const vault = new FakeVault();
    await putNewOver(vault)('ANTHROPIC_API_KEY', SENTINEL);
    expect((await vault.names()).map(secret => secret.name)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('refuses a held name in a sentence that carries the name and not the value, and keeps the held value', async () => {
    const vault = new FakeVault();
    vault.plant('ANTHROPIC_API_KEY' as never, 'the-owners-own-value');
    const before = await vault.names();
    const refusal = await putNewOver(vault)('ANTHROPIC_API_KEY', SENTINEL).then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );
    expect(refusal).toContain('ANTHROPIC_API_KEY');
    expect(refusal).not.toContain(SENTINEL);
    expect(await vault.names()).toEqual(before);
  });

  it('refuses a name the store does not accept, and a Vault that offers no create-only write, naming no value', async () => {
    const vault = new FakeVault();
    const reasons: string[] = [];
    for (const [target, name] of [
      [vault, 'not a valid name'],
      [{}, 'GOOD_NAME'],
    ] as const)
      reasons.push(
        await putNewOver(target)(name, SENTINEL).then(
          () => 'accepted',
          (error: unknown) => (error as Error).message,
        ),
      );
    expect(reasons.join('\n')).not.toContain(SENTINEL);
    expect(reasons.some(reason => reason === 'accepted')).toBe(false);
    expect(await vault.names()).toEqual([]);
  });

  it('is typed over `putNew` alone: nothing that reads or replaces is passed in', () => {
    // @ts-expect-error — `run` is not `putNew`; the port takes `Pick<VaultApi, 'putNew'>` and nothing wider is used.
    putNewOver({ run: async () => undefined });
    expect(true).toBe(true);
  });
});

describe('what the Runtimes manifest lets the import reach', () => {
  it('declares create-only secrets and the name picker, and no write-capable root on the machine’s harness homes', () => {
    const permissions: Permissions = manifest.permissions ?? {};
    expect(permissions.createSecrets).toBe(true);
    expect(permissions.secretNamePicker).toBe(true);
    // No minted names: the import can add a key but can never put, replace or remove one.
    expect(permissions.mintedSecrets).toBeUndefined();
    expect(permissions.secrets).toEqual([]);
    // r9 gives nobody a new root: `harness-home` stays the one READ-ONLY root it was.
    expect(permissions.roots).toEqual(['fleet', 'harness-home']);
  });
});
