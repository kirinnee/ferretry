import { defineSealedDocument } from '@ferretry/core-vault/contract';

/**
 * Accounts' sealed values (passwords and 2FA seeds), in today's `login-secrets.json`, now a sealed document of
 * Accounts' own in `state/accounts/` (Vault contract change C): AES-256-GCM under the vault's key, the name alone as
 * the AAD, stamped entries. The index (`accounts.json`) names each value's sealed name; this document holds the value.
 */
export const LOGIN_SECRETS = defineSealedDocument({ name: 'login-secrets', path: 'login-secrets.json' });
