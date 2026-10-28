/**
 * `<FY_HOME>/state/mcp-oauth.json`: what is known about each MCP sign-in that is NOT secret — issuer,
 * endpoints, client id, expiry. The tokens are in the secret store; this file never holds one.
 *
 * `0600` anyway: a client id and an issuer are not secrets, but they are nobody else's business.
 *
 * DAMAGED IS NOT EMPTY. A document that will not parse raises, rather than reading as "never signed in"
 * and quietly orphaning the tokens the store still holds.
 */
import { join } from 'node:path';
import { SecretNameSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import type { McpOAuthStateDocument, McpOAuthStateStore } from '../../lib/mcp-oauth/ports.ts';
import { EMPTY_MCP_OAUTH_STATE } from '../../lib/mcp-oauth/service.ts';

export const MCP_OAUTH_STATE_DOCUMENT = 'mcp-oauth.json';

const STATE_MODE = 0o600;

const Text = z.string().min(1).max(2048);

/** How a client with a secret authenticates, and where a pre-registered client's secret is named. */
const CLIENT_AUTH_SHAPE = {
  tokenAuth: z.enum(['client_secret_post', 'client_secret_basic']).optional(),
  clientSecretRef: SecretNameSchema.optional(),
} as const;

const RegistrationSchema = z.strictObject({
  issuer: Text,
  redirectUri: Text,
  paste: z.literal(true).optional(),
  clientId: Text,
  hasClientSecret: z.boolean(),
  ...CLIENT_AUTH_SHAPE,
});

const RecordSchema = z.strictObject({
  serverUrl: Text,
  issuer: Text,
  redirectUri: Text,
  tokenEndpoint: Text,
  revocationEndpoint: Text.optional(),
  clientId: Text,
  hasClientSecret: z.boolean(),
  ...CLIENT_AUTH_SHAPE,
  resource: Text,
  scope: z.string().max(2048).optional(),
  signedInAt: Text,
  expiresAt: Text.optional(),
  renewable: z.boolean(),
  needsSignIn: z.boolean().optional(),
});

const DocumentSchema = z.strictObject({
  v: z.literal(1),
  registrations: z.record(z.string(), z.array(RegistrationSchema)),
  connections: z.record(z.string(), RecordSchema),
});

export class FileMcpOAuthStateStore implements McpOAuthStateStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, MCP_OAUTH_STATE_DOCUMENT);
  }

  async read(): Promise<McpOAuthStateDocument> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return EMPTY_MCP_OAUTH_STATE;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = undefined;
    }
    const parsed = DocumentSchema.safeParse(decoded);
    if (!parsed.success) throw new Error(`${MCP_OAUTH_STATE_DOCUMENT} is not a document this daemon can read`);
    return parsed.data;
  }

  async write(document: McpOAuthStateDocument): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.path, STATE_MODE);
  }
}
