import { z } from 'zod';
import { CONNECTOR_SCOPES, type ConnectorPendingView, type ConnectorGrantView } from '../ports.ts';

const scopeSchema = z.enum(CONNECTOR_SCOPES);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const clientSchema = z.object({
  id: z.string().regex(/^fycl_[a-z2-7]{10}$/),
  name: z.string().max(100),
  redirectUris: z.array(z.string().url()).min(1).max(5),
  grantTypes: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
  secretDigest: digestSchema.optional(),
  createdAt: z.string().datetime(),
});
export type ConnectorClient = z.infer<typeof clientSchema>;
const tokenSchema = z.object({
  digest: digestSchema,
  expiresAt: z.number().finite(),
  audience: z.string(),
  scopes: z.array(scopeSchema),
});
const grantSchema = z.object({
  id: z.string().regex(/^cg_[a-z2-7]{10}$/),
  clientId: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(scopeSchema),
  createdAt: z.string().datetime(),
  approvedBy: z.string(),
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  access: z.array(tokenSchema),
  refresh: z.array(tokenSchema),
  usedRefresh: z.array(digestSchema),
});
export type ConnectorGrant = z.infer<typeof grantSchema>;
export const connectorStateSchema = z.object({
  version: z.literal(1),
  clients: z.array(clientSchema).max(20),
  grants: z.array(grantSchema),
});
export type ConnectorState = z.infer<typeof connectorStateSchema>;

/** No method on this port can receive a raw credential. A failed load must throw, never reset state. */
export interface ConnectorStore {
  load(): Promise<ConnectorState>;
  save(state: ConnectorState): Promise<void>;
}
export interface ConnectorClock {
  now(): number;
}
export interface ConnectorCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(text: string): Promise<Uint8Array>;
}

export interface PendingAuthorization {
  readonly view: ConnectorPendingView;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly challenge: string;
  readonly handleDigest: string;
  readonly decision?: 'approved' | 'denied';
  readonly grantId?: string;
}
export interface AuthorizationCode {
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly expiresAt: number;
  readonly used: boolean;
}

/** Ephemeral state and the mutex belong to one listener, shared by every authority call. */
export class ConnectorMemory {
  readonly pending = new Map<string, PendingAuthorization>();
  readonly codes = new Map<string, AuthorizationCode>();
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly retryAfter?: number,
  ) {
    super(description);
  }
}

export function grantView(grant: ConnectorGrant): ConnectorGrantView {
  const { id, clientName, redirectHost, scopes, createdAt, approvedBy, lastUsedAt, revokedAt } = grant;
  return { id, clientName, redirectHost, scopes: [...scopes], createdAt, approvedBy, lastUsedAt, revokedAt };
}
export function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export async function digest(crypto: ConnectorCrypto, value: string): Promise<string> {
  return Array.from(await crypto.sha256(value), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function canonicalResource(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    return url.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}
