import type { VaultApi } from '@ferretry/core-vault/contract';

/** A Vault with no secrets: names none, authorizes nothing. Enough for Logins to be built and asked. */
export function emptyVault(): VaultApi {
  const refuse = async (): Promise<never> => {
    throw new Error('the empty test Vault holds nothing');
  };
  return {
    names: async () => [],
    has: async () => false,
    put: async () => undefined,
    remove: async () => false,
    run: refuse,
    authorizeFetch: async () => ({ kind: 'refused' }),
    childEnvironment: refuse,
    raiseInput: refuse,
    cancelInput: async () => undefined,
    inputState: async () => undefined,
  } as unknown as VaultApi;
}
