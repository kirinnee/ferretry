/**
 * Sealed documents written by TODAY's code (rebuild-ref `bb89d054d`): `adapters/secrets/webcrypto-secret-cipher.ts`
 * (`WebCryptoSecretCipher.seal`, as `SecretDirectory` files it into `mcp-oauth-secrets.json` and `login-secrets.json`)
 * and `adapters/catalog-links/file-link-key-vault.ts` (`FileLinkKeyVault.put`, `catalogs/link-keys.json`), run
 * verbatim but for their import lines, with a FIXED FAKE key and IV so the bytes are reproducible. Every value is a
 * made-up fixture string; the key opens nothing but these files.
 *
 * `secretsKey` is today's `secrets.key` text (v5 `state/vault/vault.key`, unchanged). The documents are today's
 * bytes exactly, `"v": 1` envelope included; the only change a move makes is that key, to `"format": 1`.
 */
export const TODAY_FIXED_IV = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
export const TODAY_INSTANT = '2026-03-01T00:00:00.000Z';
export const secretsKey = 'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=\n';
/** `mcp-oauth-secrets.json`: `MCP_DOCS_EXAMPLE_REFRESH` = `fixture-refresh-token-not-a-real-one`. */
export const mcpOAuthSecrets =
  '{\n  "v": 1,\n  "cipher": "AES-256-GCM",\n  "entries": {\n    "MCP_DOCS_EXAMPLE_REFRESH": {\n      "iv": "oKGio6Slpqeoqaqr",\n      "ciphertext": "He0LfZgPyvhm40wiT2yEbW9BVAv+yowLUdV4flBTSeDrU2K8O5/wYQqc7yvju/B7me0eng==",\n      "createdAt": "2026-03-01T00:00:00.000Z",\n      "updatedAt": "2026-03-01T00:00:00.000Z"\n    }\n  }\n}\n';
/** `login-secrets.json`: `ACCOUNT_FIXTURE_PASSWORD` = `fixture-password-not-real-42`. */
export const loginSecrets =
  '{\n  "v": 1,\n  "cipher": "AES-256-GCM",\n  "entries": {\n    "ACCOUNT_FIXTURE_PASSWORD": {\n      "iv": "oKGio6Slpqeoqaqr",\n      "ciphertext": "He0LfZgPyvhk51kjXXCeJDZAUBq9lYcFSdUtYfpMSET4Oe80cXkt/dRgpA8=",\n      "createdAt": "2026-03-01T00:00:00.000Z",\n      "updatedAt": "2026-03-01T00:00:00.000Z"\n    }\n  }\n}\n';
/** `catalogs/link-keys.json` (AAD `catalog-link:<id>`, no instants): `lnk_AAAAAAAAAAAAAAAAAAAAAA` = `fixture-link-key-not-real`. */
export const linkKeys =
  '{\n  "v": 1,\n  "cipher": "AES-256-GCM",\n  "entries": {\n    "lnk_AAAAAAAAAAAAAAAAAAAAAA": {\n      "iv": "oKGio6Slpqeoqaqr",\n      "ciphertext": "He0LfZgPyvh470Q7B3SJOTZAUBq9lYcFSQn4DsVmlWXjSkvJtxsplg0="\n    }\n  }\n}\n';
