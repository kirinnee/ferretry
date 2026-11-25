/**
 * Handing a RUNNING ferret the current token behind one of its own MCP sign-in variables
 * (`POST /v1/ferrets/:ferretId/mcp/token`, docs/mcp-oauth.md › A ferret that outlives its token).
 *
 * WHY. A signed-in MCP server reaches a Claude ferret as an `Authorization: Bearer ${VARIABLE}` header whose variable
 * was resolved ONCE, at launch. An access token lives hours (Slack's: twelve), a ferret can live weeks, and `/mcp`
 * reconnects with the same stale variable. Claude Code runs a server's `headersHelper` at connect time and again after a
 * 401; the helper is `fy mcp token <VARIABLE>`, and this is what it asks.
 *
 * THE BOUNDARY (docs/secrets.md › The one exception). This is the one place a secret VALUE leaves the Vault through a
 * route, and it extends the sign-in in time and no further: the ferret already holds this very token in its environment
 * (the documented GAP), and this hands it that token renewed. It never names a secret (only a variable of the sign-in
 * shape), it answers only for a server the ferret's OWN launch holds now (`McpLaunchParts.bindings`, so another ferret's
 * folder, runtime or project can never be asked about), and the Vault gives the value back only for a secret THIS plugin
 * minted (the Vault's `MintedValueReader`). It writes nothing, and an error never carries provider text or the token.
 */
import type { FerretId, FencedPath } from '@ferretry/kernel/contract';
import type { SecretName } from '@ferretry/core-vault/contract';
import { MCP_TOKEN_CODES, type McpTokenAnswer, parseMcpProjectSubject } from '../../../contract/index.ts';
import type { McpLaunchSubject } from '../../lib/launch-parts.ts';

/** A refusal in plain words, restated in the HTTP vocabulary by the route. */
export class McpTokenRefusal extends Error {
  constructor(
    readonly status: 404 | 409 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpTokenRefusal';
  }
}

/** What the service reads of one ferret: the harness, runtime and folder its launch is made from. */
interface TokenFerret {
  readonly id: string;
  readonly harness: McpLaunchSubject['harness'];
  readonly folder: string;
  readonly runtime?: string;
}

export interface FerretMcpTokensDeps {
  ferret(id: string): Promise<TokenFerret | undefined>;
  /** `McpLaunchParts.bindings`: the sign-in variables this ferret's launch holds now and their secret names. Renews NOTHING. */
  bindings(subject: McpLaunchSubject): Promise<ReadonlyMap<string, SecretName>>;
  /** `McpOAuthService.refreshForLaunch([name])`: make THIS one sign-in current. Never throws. */
  renew(name: SecretName): Promise<void>;
  /** The clock the request budget reads, in epoch milliseconds. */
  now(): number;
  /** `McpOAuthService.signInRequired`: the sign-in (a component or a project subject) whose refresh was rejected. */
  signInRequired(name: SecretName): Promise<string | undefined>;
  /** `MintedValueReader.mintedValue`, read through `mintedValueOf`: the value of a secret this plugin minted; absent where the Vault does not offer it. */
  value(name: SecretName): Promise<string | undefined>;
}

/** The per-ferret request budget: this many answers (the refusals included) in any one window. */
const TOKEN_BUDGET = { requests: 30, windowMs: 60_000 } as const;

export class FerretMcpTokens {
  /** When each ferret's recent requests were made: the sliding window the budget counts. */
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly deps: FerretMcpTokensDeps) {}

  /** Spends one request of the ferret's budget before anything else is read or started. */
  private spend(ferretId: string): void {
    const now = this.deps.now();
    const live = (this.recent.get(ferretId) ?? []).filter(at => now - at < TOKEN_BUDGET.windowMs);
    if (live.length >= TOKEN_BUDGET.requests) {
      this.recent.set(ferretId, live);
      throw new McpTokenRefusal(
        429,
        MCP_TOKEN_CODES.tooManyRequests,
        'This ferret has asked for its MCP sign-in token too often; wait a minute and ask again.',
      );
    }
    this.recent.set(ferretId, [...live, now]);
  }

  /** The headers Claude's `headersHelper` prints, or a refusal in plain words. */
  async headers(ferretId: string, variable: string): Promise<McpTokenAnswer> {
    this.spend(ferretId);
    const ferret = await this.deps.ferret(ferretId);
    if (ferret === undefined)
      throw new McpTokenRefusal(404, MCP_TOKEN_CODES.notThisFerretsServer, `there is no ferret ${ferretId}`);
    const bound = await this.deps.bindings({
      ferret: ferret.id as FerretId,
      harness: ferret.harness,
      folder: ferret.folder as FencedPath,
      ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
    });
    const name = bound.get(variable);
    if (name === undefined)
      throw new McpTokenRefusal(
        404,
        MCP_TOKEN_CODES.notThisFerretsServer,
        `${variable} is not a sign-in variable this ferret was launched with, so there is no token to give it.`,
      );
    // The binding is known and is this ferret's own: only now is the provider asked, and only for this one sign-in.
    await this.deps.renew(name);
    const component = await this.deps.signInRequired(name);
    const token = component === undefined ? await this.deps.value(name) : undefined;
    if (token === undefined || token.trim() === '')
      throw new McpTokenRefusal(
        409,
        MCP_TOKEN_CODES.needsSignIn,
        `The sign-in to “${component === undefined ? variableLabel(variable) : label(component)}” can no longer be renewed, so there is no working token for this ferret. Ask the owner to sign in to that server again in Ferretry (fy mcp ls shows which servers need it).`,
      );
    return { variable, headers: { Authorization: `Bearer ${token.trim()}` } };
  }
}

/** A sign-in's component name as a person knows the server: a project server's subject is its name and a folder. */
const label = (component: string): string => parseMcpProjectSubject(component)?.name ?? component;

/** The server a sign-in variable belongs to, as far as the variable says: `FY_MCP_<NAME>_<16 hex>_TOKEN`. */
const variableLabel = (variable: string): string =>
  /^FY_MCP_(?:([A-Z0-9_]+?)_)?[0-9A-F]{16}_TOKEN$/u.exec(variable)?.[1]?.toLowerCase().replaceAll('_', '-') ?? variable;
