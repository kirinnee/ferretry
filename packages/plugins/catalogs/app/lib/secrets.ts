/**
 * THE NAMES OF THIS MACHINE'S SECRETS, for the install mapping (`GET /v1/secrets`, the Vault's, behind the secrets-use
 * grant). A placeholder in an installed file maps to a NAME the installer picks here; a value is never listed, read or
 * sent. Catalogs' manifest declares `permissions.secretNamePicker` for exactly this read.
 */
import { z } from 'zod';
import { type CatalogClient, SECRET_NAMES_PATH } from './catalog-client.ts';

const SecretListSchema = z.looseObject({
  health: z.enum(['ready', 'damaged']),
  secrets: z.array(z.looseObject({ name: z.string().min(1) })),
});
export type SecretList = z.infer<typeof SecretListSchema>;

/** A sign-in's OAuth access token (copied from the protocol's `isSignInSecretName`): never offered to a placeholder. */
export const isSignInSecretName = (name: string): boolean => /^MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS$/u.test(name);

export const parseSecretList = (answer: unknown): SecretList => SecretListSchema.parse(answer);

/** This machine's secret names (`GET /v1/secrets`), through the half's client. */
export const listSecrets = (client: CatalogClient): Promise<SecretList> =>
  client.request(SECRET_NAMES_PATH, SecretListSchema);
