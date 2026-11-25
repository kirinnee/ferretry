/**
 * A running ferret asking for a fresh token (`POST /v1/ferrets/:ferretId/mcp/token`, docs/mcp-oauth.md › A ferret that
 * outlives its token): the one route that hands a secret value back, and only to the ferret whose own launch holds it
 * (docs/secrets.md › The one exception).
 */
import { z } from 'zod';

/**
 * The shape of every launch variable a sign-in's access token travels in (`mcpOAuthSecretNames().variable`): the ONLY
 * thing the route will name. It is a variable NAME, never a path or a secret name, so a ferret cannot ask for anything
 * its own launch did not already put in its environment.
 */
export const MCP_TOKEN_VARIABLE_PATTERN = /^FY_MCP_[A-Z0-9_]+_TOKEN$/u;

/** A ferret's request for the current token behind one of its own launch variables. */
export const McpTokenRequestSchema = z.strictObject({
  variable: z.string().min(1).max(256).regex(MCP_TOKEN_VARIABLE_PATTERN, 'not an MCP sign-in token variable'),
});
export type McpTokenRequest = z.infer<typeof McpTokenRequestSchema>;

/**
 * The answer: the HTTP headers Claude Code's `headersHelper` prints for that server. `variable` echoes the NAME asked
 * for, so the security log can record which one without ever reading the token.
 */
export const McpTokenAnswerSchema = z.strictObject({
  variable: z.string().regex(MCP_TOKEN_VARIABLE_PATTERN),
  headers: z.strictObject({ Authorization: z.string().min(1) }),
});
export type McpTokenAnswer = z.infer<typeof McpTokenAnswerSchema>;

/** The refusal codes of the route (the HTTP words of {@link McpTokenRefusal}). */
export const MCP_TOKEN_CODES = {
  /** Only the ferret itself may ask: anybody else, the admin token included. */
  notThisFerret: 'not_this_ferret',
  /** The variable is not one this ferret's launch holds. */
  notThisFerretsServer: 'not_this_ferrets_server',
  /** This ferret has used up its request budget for now. */
  tooManyRequests: 'too_many_requests',
  /** The sign-in was rejected or holds no token: only the owner can mend it. */
  needsSignIn: 'mcp_needs_sign_in',
} as const;

/** The largest request body the route reads: a variable name and its braces, never more. */
export const MCP_TOKEN_BODY_BYTES = 1024;

/**
 * The command Claude's `headersHelper` runs: `<client> mcp token <VARIABLE>`. The ONE spelling both writers of an entry
 * use; the client is the product's binary name as the daemon knows it (`kernel.identity.binaries.client`), never a literal.
 */
export const mcpTokenCommand = (client: string, variable: string): string =>
  `${/^[A-Za-z0-9_.\/-]+$/u.test(client) ? client : `'${client.replaceAll("'", "'\\''")}'`} mcp token ${variable}`;
