/**
 * THE NAMES OF THIS MACHINE'S SECRETS, for the install mapping (`GET /v1/secrets`, the Vault's). A placeholder in an
 * installed file maps to a NAME the installer picks here; a value is never listed, read or sent.
 *
 * The read is governed by the Vault route's own grant (`operator`, `secrets.use`). Catalogs' `permissions.secretNamePicker`
 * only widens what the Catalogs DAEMON half's Vault port lists; it does not govern this browser read.
 *
 * THE ANSWER IS PARSED BY THE VAULT'S OWN STRICT SCHEMA, so a Vault that regressed to carry a `value` or a digest, or a
 * name outside the grammar, is refused at this boundary instead of being held in browser memory (docs/secrets.md,
 * "use, never read").
 */
import { SecretListSchema, type SecretList } from '@ferretry/core-vault/contract';
import { type CatalogClient, SECRET_NAMES_PATH } from './catalog-client.ts';

export type { SecretList };

/** A sign-in's OAuth access token (copied from the protocol's `isSignInSecretName`): never offered to a placeholder. */
export const isSignInSecretName = (name: string): boolean => /^MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS$/u.test(name);

export const parseSecretList = (answer: unknown): SecretList => SecretListSchema.parse(answer);

/** This machine's secret names (`GET /v1/secrets`), through the half's client. */
export const listSecrets = (client: CatalogClient): Promise<SecretList> =>
  client.request(SECRET_NAMES_PATH, SecretListSchema);
