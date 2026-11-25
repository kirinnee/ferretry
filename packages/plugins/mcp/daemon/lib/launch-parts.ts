import {
  type HarnessKey,
  isKnownHarnessKey,
  type KnownHarnessKey,
  type LaunchPart,
  type LaunchPartSource,
  type LaunchSpec,
} from '@ferretry/core-ferrets/contract';
import {
  optionalSecretReference,
  optionalSecretReferenceOf,
  type SecretName,
  secretReferencesIn,
} from '@ferretry/core-vault/contract';
import type { JsonValue } from '@ferretry/std';
import {
  MCP_TOKEN_VARIABLE_PATTERN,
  McpEnvSchema,
  type McpItem,
  type McpOAuthSecretNames,
  mcpOAuthSecretNames,
  mcpTokenCommand,
} from '../../contract/index.ts';
import { isSseAddress } from './inventory/declarations.ts';
import type { ProjectMcpLaunchShare } from './inventory/project-sign-in.ts';

/** The document a harness takes its MCP servers in (`HarnessFacts.mcp.format`). */
type McpDocumentFormat = 'json' | 'toml';

/** One configured server as a launch part. */
type McpLaunchPart = Extract<LaunchPart, { readonly kind: 'mcp' }>;

/**
 * The `launch.parts` a launch gets from `config/mcp/*.yaml` (§4.9): one `mcp` part per item the harness may run (an
 * item that names a harness is for that harness only). Inert: a part is a name and the item as data. `env` keeps its
 * `${secret:NAME}` references; the Vault opens them for the child at the moment it starts, so no value is here.
 */
export function mcpParts(
  items: ReadonlyMap<string, McpItem>,
  harness: KnownHarnessKey,
  format?: McpDocumentFormat,
): readonly McpLaunchPart[] {
  const parts: McpLaunchPart[] = [];
  for (const [name, item] of [...items].sort(([left], [right]) => left.localeCompare(right))) {
    if (item.harness !== undefined && item.harness !== harness) continue;
    if (item.env !== undefined && !McpEnvSchema.safeParse(item.env).success)
      throw new Error(
        `The MCP server environment is invalid. Store credentials with fy secret set NAME and use \${secret:NAME}.`,
      );
    parts.push({ kind: 'mcp', name, config: plainConfig(item, format) });
  }
  return parts;
}

/**
 * One item as the harness reads it. A server reached at a `url` is written as the document's own entry: Claude's
 * `{ type, url }` (an entry with no `type` is read as a command to start, and `auth` / `oauth` are keys it does not
 * read), Codex's `{ url }`. A harness with no MCP format on record keeps the item as configured, and a server Ferretry
 * starts is never rewritten.
 */
function plainConfig(item: McpItem, format: McpDocumentFormat | undefined): JsonValue {
  const { harness: _harness, ...config } = item;
  if (item.url === undefined || format === undefined) return config as JsonValue;
  return format === 'toml' ? { url: item.url } : { type: isSseAddress(item.url) ? 'sse' : 'http', url: item.url };
}

/**
 * A signed-in server as the harness reads it (both harnesses write `part.config` verbatim, so it is made harness-ready
 * here). The token's VARIABLE is named, never its value (the Vault binds it into the child): Claude expands `${VAR}` in
 * a header (the shape `project-sign-in.ts` writes and the inventory recognises, a JSON document), Codex reads
 * `bearer_token_env_var` (a TOML table). The harness says which it takes (`HarnessFacts.mcp.format`). None of `auth`, `oauth` or `bearer` is a key either harness reads.
 */
function signedInConfig(url: string, variable: string, format: McpDocumentFormat, client: string): JsonValue {
  if (format === 'toml') return { url, bearer_token_env_var: variable };
  return {
    type: isSseAddress(url) ? 'sse' : 'http',
    url,
    headers: { Authorization: `Bearer \${${variable}}` },
    // Claude runs this at connect time and again after a 401, so a ferret that outlives its token sends the renewed one.
    headersHelper: mcpTokenCommand(client, variable),
  };
}

/** The launch's share of the sign-in service: make due tokens current. Never throws (`McpOAuthService.refreshForLaunch`). */
interface McpLaunchRenewal {
  refreshForLaunch(names: readonly SecretName[]): Promise<void>;
}

export interface McpLaunchPartsDeps {
  items(): ReadonlyMap<string, McpItem>;
  /** Which secret NAMES the Vault holds — never a value (use, never read). */
  held(): Promise<ReadonlySet<SecretName>>;
  readonly renewal: McpLaunchRenewal;
  /** The document format a harness takes MCP servers in; undefined for a harness this machine does not know. */
  mcpFormat(harness: HarnessKey): McpDocumentFormat | undefined;
  /**
   * The item names the launch's runtime profile stack carries (D10). A launch with no runtime, or a runtime whose
   * stack cannot be resolved, carries none.
   */
  layered(runtime: string | undefined): Promise<ReadonlySet<string>>;
  /** The launch's project servers (`ProjectMcpLaunch.share`), after their own renewal. */
  project(spec: McpLaunchSubject, options?: { readonly renew: boolean }): Promise<ProjectMcpLaunchShare>;
  /** The product's client binary name (`kernel.identity.binaries.client`): the command a `headersHelper` runs. */
  readonly client: string;
}

/**
 * What of a launch decides which servers it carries: the ferret, its harness, runtime and folder. A running ferret's
 * summary answers all of it (the token route asks what ITS launch holds now), so the launch's whole spec is not needed.
 */
export type McpLaunchSubject = Pick<LaunchSpec, 'ferret' | 'harness' | 'runtime' | 'folder'> & {
  /** The ferret's home, when the caller has it: only a launch without a published runtime reads it. */
  readonly home?: string;
};

/**
 * MCP's `launch.parts` source: today's `FleetLaunchEnvironment` and `ProjectMcpLaunch` together, asked per launch.
 *
 * 1. RENEWAL ON USE (today's `launch-environment.ts`): every access token this launch names — a signed-in server's,
 *    and every `${secret:NAME}` an item's `env` names — is made current just before the launch, by the sign-in
 *    service, which never throws. A refresh that fails leaves the old token where it was (the server then says it
 *    needs a new sign-in) and the launch goes ahead.
 * 2. One `mcp` part per item the runtime's profile stack names ({@link mcpParts}); a signed-in one names its `bearer`
 *    VARIABLE (rendered by {@link signedInConfig}: Claude as an `Authorization` header, Codex as `bearer_token_env_var`).
 * 3. One `mcp` part per signed-in project server, as the local-scope entry for its project root.
 * 4. One `env` part binding each sign-in variable to its OPTIONAL `${secret?:NAME}` reference. The Vault opens the
 *    references into the child as it starts, so no part holds a value. Only a token the Vault HOLDS is bound: an
 *    unbound reference would refuse the whole launch over one server nobody signed in to. An item's own `env` keeps
 *    its plain `${secret:NAME}` references, which still refuse when missing.
 *
 * A SIGN-OUT RACING A LAUNCH never refuses it (today's launch read the value once into the environment). What is held
 * is sampled here, but the references are opened only once every `launch.parts` source has answered; a token signed
 * out in between is not held then, and the Vault leaves its variable unset — the server then reads as not signed in.
 */
export class McpLaunchParts implements LaunchPartSource {
  constructor(private readonly deps: McpLaunchPartsDeps) {}

  async parts(spec: Omit<LaunchSpec, 'parts'>): Promise<readonly LaunchPart[]> {
    return await this.compose(spec, true);
  }

  /**
   * Which sign-in variable each of this ferret's servers reads its token from, and the secret NAME behind it, as a
   * launch would bind them NOW: never a value, and WITHOUT renewing anything (no machine, project or env sign-in is
   * refreshed). What the token route reads first, so it can only ever answer for a server this ferret's own launch holds,
   * and starts provider work only once the one binding it was asked for is known.
   */
  async bindings(subject: McpLaunchSubject): Promise<ReadonlyMap<string, SecretName>> {
    const bound = new Map<string, SecretName>();
    for (const part of await this.compose(subject, false))
      if (part.kind === 'env')
        for (const [variable, reference] of Object.entries(part.env)) {
          const name = optionalSecretReferenceOf(reference);
          if (name !== undefined && MCP_TOKEN_VARIABLE_PATTERN.test(variable)) bound.set(variable, name);
        }
    return bound;
  }

  private async compose(spec: McpLaunchSubject, renew: boolean): Promise<readonly LaunchPart[]> {
    // Only the items this runtime's profile stack names, as a v4 runtime home held only its profile's components.
    const layered = await this.deps.layered(spec.runtime);
    const items = new Map([...this.deps.items()].filter(([name]) => layered.has(name)));
    const format = this.deps.mcpFormat(spec.harness);
    // A harness whose MCP format this plugin does not write gets no servers from it: never another harness's.
    const servers = isKnownHarnessKey(spec.harness) ? mcpParts(items, spec.harness, format) : [];
    const signedIn = new Map<string, { readonly names: McpOAuthSecretNames; readonly url: string }>();
    const named = new Set<SecretName>();
    for (const part of servers) {
      const item = items.get(part.name);
      if (item === undefined) continue;
      if (item.auth === 'oauth' && item.url !== undefined) {
        const names = mcpOAuthSecretNames(part.name, item.url);
        signedIn.set(part.name, { names, url: item.url });
        named.add(names.access);
      }
      for (const value of Object.values(item.env ?? {})) for (const name of secretReferencesIn(value)) named.add(name);
    }
    const [project] = await Promise.all([
      this.deps.project(spec, { renew }),
      renew && named.size > 0 ? this.deps.renewal.refreshForLaunch([...named]) : undefined,
    ]);
    const held = signedIn.size === 0 ? new Set<SecretName>() : await this.deps.held();
    const env: Record<string, string> = { ...project.env };
    const parts: LaunchPart[] = servers.map(part => {
      const server = signedIn.get(part.name);
      if (server === undefined || !held.has(server.names.access)) return part;
      env[server.names.variable] = optionalSecretReference(server.names.access);
      // A harness with no MCP format on record is written no sign-in it could not read: the entry stays as configured.
      return format === undefined
        ? part
        : { ...part, config: signedInConfig(server.url, server.names.variable, format, this.deps.client) };
    });
    for (const [name, server] of Object.entries(project.servers))
      parts.push({
        kind: 'mcp',
        name,
        config: {
          ...server,
          headers: { ...server.headers },
          ...projectHelper(server.headers.Authorization, format, this.deps.client),
          scope: 'local',
          project: project.root,
        },
      });
    if (Object.keys(env).length > 0) parts.push({ kind: 'env', env });
    return parts;
  }
}

/** A project server's `headersHelper`, when Claude reads it and its header names a sign-in variable (the same command as a machine server's). */
function projectHelper(
  authorization: string | undefined,
  format: McpDocumentFormat | undefined,
  client: string,
): Record<string, string> {
  const variable = /^Bearer \$\{([A-Z0-9_]+)\}$/u.exec(authorization ?? '')?.[1];
  return format === 'json' && variable !== undefined && MCP_TOKEN_VARIABLE_PATTERN.test(variable)
    ? { headersHelper: mcpTokenCommand(client, variable) }
    : {};
}
