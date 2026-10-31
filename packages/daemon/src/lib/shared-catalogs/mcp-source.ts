/**
 * An MCP server on this machine, turned into the setup a catalog carries. Pure.
 *
 * Two sources, two rules:
 *
 *  - a fleet `mcp` COMPONENT is Ferretry's own record and converts directly. Its `${secret:NAME}` values
 *    stay placeholders (the installer fills them from their own store), and an OAuth `clientSecret` is
 *    left out — it is a reference to THIS machine's store, and a client secret never travels. The
 *    omission is said, not silent.
 *  - a server some harness reads from `.mcp.json`, `~/.claude.json` or `config.toml` is whatever somebody
 *    typed there. If an environment value in it uses `${VAR}` (read from the environment of whoever starts
 *    it, so there is nothing to carry) or looks like a raw key, it is REFUSED with the contract's sentence
 *    and how to fix it. The catalog contract is the last word either way: the setup is parsed through it.
 *
 * Ferretry's own tools server is started by every Ferretry install, so there is nothing to share.
 */
import {
  CatalogItemNameSchema,
  type CatalogHarness,
  type CatalogMcpSetup,
  CatalogMcpSetupSchema,
  type CatalogSourceProblem,
  type McpScope,
} from '@ferretry/protocol';
import type { McpDeclaration } from '../mcp-inventory/declarations.ts';

/** The fields of a fleet `mcp` component that a catalog setup is made from. */
export interface McpComponentRecord {
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly auth?: 'oauth' | undefined;
  readonly oauth?:
    | {
        readonly clientId: string;
        readonly clientSecret?: string | undefined;
        readonly callbackPort?: number | undefined;
      }
    | undefined;
  readonly harness?: CatalogHarness | undefined;
}

/** One server the machine inventory lists, with what a conversion needs. */
export interface McpSourceServer {
  readonly id: string;
  readonly name: string;
  readonly scope: McpScope;
  readonly harness: 'claude' | 'codex';
  /** The file that declares it, when it has one. */
  readonly source?: string | undefined;
  readonly declaration: McpDeclaration | null;
  /** The component record, when `scope` is `component` and the record is still there. */
  readonly component?: McpComponentRecord | undefined;
}

export type McpConversion =
  | {
      readonly ok: true;
      readonly setup: CatalogMcpSetup;
      readonly harness?: CatalogHarness;
      readonly problems: readonly CatalogSourceProblem[];
    }
  | { readonly ok: false; readonly reason: string };

// biome-ignore lint/suspicious/noTemplateCurlyInString: the reference grammar, written out for a person to read
const HOW_TO_FIX =
  'Put the key in the secret store, declare the server as a fleet MCP component with the value ${secret:NAME}, and add that component instead.';

const refused = (reason: string): McpConversion => ({ ok: false, reason });

export function describeMcpServer(server: McpSourceServer): string {
  return `${server.name} (${server.scope}${server.source === undefined ? '' : `, ${server.source}`})`;
}

/** Turns a candidate into the contract's setup, or the contract's own sentence about why not. */
function parsed(
  server: McpSourceServer,
  candidate: unknown,
  harness: CatalogHarness | undefined,
  problems: readonly CatalogSourceProblem[],
): McpConversion {
  const result = CatalogMcpSetupSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
    return refused(
      `${server.name} cannot be shared as it is: ${where}${issue?.message ?? 'it is malformed'}. ${HOW_TO_FIX}`,
    );
  }
  return { ok: true, setup: result.data, ...(harness === undefined ? {} : { harness }), problems };
}

/** A component's own record. Env values, `${secret:NAME}` included, go through unchanged. */
function fromComponent(server: McpSourceServer, component: McpComponentRecord): McpConversion {
  const problems: CatalogSourceProblem[] = [];
  if (component.url !== undefined) {
    if (component.oauth?.clientSecret !== undefined)
      problems.push({
        subject: 'oauth.clientSecret',
        reason: "not carried: it is a reference to this machine's secret store, and a client secret never travels",
      });
    const oauth =
      component.oauth === undefined
        ? undefined
        : {
            clientId: component.oauth.clientId,
            ...(component.oauth.callbackPort === undefined ? {} : { callbackPort: component.oauth.callbackPort }),
          };
    return parsed(
      server,
      {
        transport: 'url',
        url: component.url,
        ...(component.auth === undefined ? {} : { auth: component.auth }),
        ...(oauth === undefined ? {} : { oauth }),
      },
      component.harness,
      problems,
    );
  }
  return parsed(
    server,
    {
      transport: 'command',
      command: component.command ?? '',
      args: [...(component.args ?? [])],
      env: { ...(component.env ?? {}) },
    },
    component.harness,
    problems,
  );
}

/** One entry some harness reads. Nothing in it may need the environment of whoever starts it. */
function fromDeclaration(server: McpSourceServer, declaration: McpDeclaration): McpConversion {
  if (declaration.transport === 'stdio') {
    const variable = Object.entries(declaration.env).find(([, value]) => value.includes('${'));
    if (variable !== undefined)
      return refused(
        `${server.name} cannot be shared as it is: environment ${variable[0]} uses a \${…} substitution, which is read from the environment of whoever starts it, so there is nothing to carry. ${HOW_TO_FIX}`,
      );
    return parsed(
      server,
      { transport: 'command', command: declaration.command, args: [...declaration.args], env: { ...declaration.env } },
      undefined,
      [],
    );
  }
  const problems: CatalogSourceProblem[] = [];
  if (Object.keys(declaration.headers).length > 0)
    problems.push({
      subject: 'headers',
      reason: 'not carried: a header can hold a credential, and a catalog carries none',
    });
  if (declaration.bearerVariable !== undefined)
    problems.push({
      subject: 'bearer_token_env_var',
      reason: 'not carried: it names a variable on this machine, and a token never travels',
    });
  return parsed(
    server,
    {
      transport: 'url',
      url: declaration.url,
      ...(declaration.oauth === undefined
        ? {}
        : {
            auth: 'oauth',
            oauth: {
              clientId: declaration.oauth.clientId,
              ...(declaration.oauth.callbackPort === undefined ? {} : { callbackPort: declaration.oauth.callbackPort }),
            },
          }),
    },
    undefined,
    problems,
  );
}

/** The setup a catalog would carry for this server, or the sentence for why it cannot be shared. */
export function mcpSetupOf(server: McpSourceServer): McpConversion {
  if (server.scope === 'ferretry')
    return refused("Ferretry's own tools server is not shareable: every Ferretry install already starts it.");
  if (!CatalogItemNameSchema.safeParse(server.name).success)
    return refused(
      `${JSON.stringify(server.name)} is not a name a catalog item can have: use letters, digits, - and _.`,
    );
  if (server.scope === 'component') {
    if (server.component === undefined)
      return refused(`${server.name} is a fleet component that is not in this machine's fleet configuration any more.`);
    return fromComponent(server, server.component);
  }
  if (server.declaration === null) return refused(`${server.name} has no declaration to read.`);
  return fromDeclaration(server, server.declaration);
}

export type McpLookup =
  | { readonly kind: 'found'; readonly server: McpSourceServer }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly McpSourceServer[] };

/** An inventory id exactly, or else a server name. Several servers by one name are never guessed between. */
export function lookupMcpServer(servers: readonly McpSourceServer[], reference: string): McpLookup {
  const byId = servers.find(server => server.id === reference);
  if (byId !== undefined) return { kind: 'found', server: byId };
  const named = servers.filter(server => server.name === reference && server.scope !== 'ferretry');
  const only = named[0];
  if (only === undefined) return { kind: 'unknown' };
  return named.length === 1 ? { kind: 'found', server: only } : { kind: 'ambiguous', candidates: named };
}
