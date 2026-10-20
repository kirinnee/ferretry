import { describe, expect, it } from 'bun:test';
import { isSignInSecretName, mcpOAuthSecretNames } from '../../src/lib/mcp-oauth.ts';
import {
  CloneableSecretNameSchema,
  SECRET_CLONE_REFUSALS,
  SealedSecretBundleSchema,
  SecretCloneNamesSchema,
  SecretCloneRefusalSchema,
  SecretExportRequestSchema,
  SecretExportResponseSchema,
  SecretImportCompleteRequestSchema,
  SecretImportIdSchema,
  SecretImportOfferSchema,
  SecretImportResultSchema,
} from '../../src/lib/secret-clone.ts';

const SOURCE = `fy_daemon_${'S'.repeat(43)}`;
const TARGET = `fy_daemon_${'T'.repeat(43)}`;
const IMPORT_ID = `fy_secret_import_${'a'.repeat(22)}`;
const AT = '2026-10-20T10:05:00.000Z';
const API_KEY = CloneableSecretNameSchema.parse('API_KEY');

const OFFER = {
  v: 1,
  importId: IMPORT_ID,
  daemonId: TARGET,
  identityKey: 'MCowBQYDK2VwAyEA',
  publicKey: 'cHVibGlj',
  expiresAt: AT,
  signature: 'c2ln',
} as const;

const BUNDLE = {
  v: 1,
  importId: IMPORT_ID,
  sourceDaemonId: SOURCE,
  targetDaemonId: TARGET,
  expiresAt: AT,
  names: [API_KEY],
  ephemeralKey: 'ZXBo',
  nonce: 'bm9uY2U',
  ciphertext: 'Y2lwaGVy',
} as const;

describe('a secret import id', () => {
  it('should be the import prefix and 128 random bits', () => {
    expect(SecretImportIdSchema.safeParse(IMPORT_ID).success).toBe(true);
    expect(SecretImportIdSchema.safeParse(`fy_secret_import_${'a'.repeat(21)}`).success).toBe(false);
    expect(SecretImportIdSchema.safeParse('fy_pair_aaaaaaaaaaaaaaaaaaaaaa').success).toBe(false);
  });
});

describe('the names to copy', () => {
  it('should hold at least one name, each once', () => {
    expect(SecretCloneNamesSchema.safeParse(['A', 'B']).success).toBe(true);
    expect(SecretCloneNamesSchema.safeParse([]).success).toBe(false);
    expect(SecretCloneNamesSchema.safeParse(['A', 'A']).success).toBe(false);
    expect(SecretCloneNamesSchema.safeParse(['lower']).success).toBe(false);
  });
});

describe('a secret a copy may carry', () => {
  it('should be a key a person stored, never a sign-in token', () => {
    expect(CloneableSecretNameSchema.safeParse('GLM_API_KEY').success).toBe(true);
    expect(CloneableSecretNameSchema.safeParse('MCP_SERVER_KEY').success).toBe(true);
    for (const component of ['linear', 'my-server', 'ü—ü'])
      expect(
        CloneableSecretNameSchema.safeParse(mcpOAuthSecretNames(component, 'https://mcp.example.com/mcp').access)
          .success,
      ).toBe(false);
  });

  it('should refuse a sign-in token anywhere a copy names secrets', () => {
    const token = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;
    expect(isSignInSecretName(token)).toBe(true);
    expect(SecretCloneNamesSchema.safeParse([token]).success).toBe(false);
    expect(SecretExportRequestSchema.safeParse({ offer: OFFER, names: ['API_KEY', token] }).success).toBe(false);
    expect(SealedSecretBundleSchema.safeParse({ ...BUNDLE, names: [token] }).success).toBe(false);
  });
});

describe('an import offer', () => {
  it('should carry only public facts, strictly', () => {
    expect(SecretImportOfferSchema.parse(OFFER)).toEqual(OFFER);
    expect(SecretImportOfferSchema.safeParse({ ...OFFER, privateKey: 'x' }).success).toBe(false);
    expect(SecretImportOfferSchema.safeParse({ ...OFFER, publicKey: 'not base64url!' }).success).toBe(false);
    expect(SecretImportOfferSchema.safeParse({ ...OFFER, v: 2 }).success).toBe(false);
  });

  it('should be what an export request names, with the names to seal', () => {
    expect(SecretExportRequestSchema.parse({ offer: OFFER, names: ['API_KEY'] }).names).toEqual([API_KEY]);
    expect(SecretExportRequestSchema.safeParse({ offer: OFFER, names: [] }).success).toBe(false);
  });
});

describe('a sealed bundle', () => {
  it('should have no field for a value, and refuse one added', () => {
    expect(SealedSecretBundleSchema.parse(BUNDLE)).toEqual(BUNDLE);
    expect(SealedSecretBundleSchema.safeParse({ ...BUNDLE, value: 'sk-live-abcdef' }).success).toBe(false);
    expect(SecretExportResponseSchema.parse({ bundle: BUNDLE, names: [API_KEY] }).bundle).toEqual(BUNDLE);
    expect(SecretImportCompleteRequestSchema.parse({ bundle: BUNDLE }).bundle).toEqual(BUNDLE);
  });

  it('should answer an import with the names that arrived and those that replaced one', () => {
    const result = { importId: IMPORT_ID, sourceDaemonId: SOURCE, imported: [API_KEY], replaced: [] };
    expect(SecretImportResultSchema.parse(result)).toEqual(result);
  });
});

describe('a clone refusal', () => {
  it('should be one of the closed set', () => {
    for (const refusal of SECRET_CLONE_REFUSALS) expect(SecretCloneRefusalSchema.parse(refusal)).toBe(refusal);
    expect(SecretCloneRefusalSchema.safeParse('nope').success).toBe(false);
  });
});
