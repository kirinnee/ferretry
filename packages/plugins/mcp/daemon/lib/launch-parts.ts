import type { HarnessKey, LaunchPart, LaunchPartSource, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { optionalSecretReference, type SecretName, secretReferencesIn } from '@ferretry/core-vault/contract';
import type { JsonValue } from '@ferretry/std';
import { McpEnvSchema, type McpItem, type McpOAuthSecretNames, mcpOAuthSecretNames } from '../../contract/index.ts';
import type { ProjectMcpLaunchShare } from './inventory/project-sign-in.ts';

/** One configured server as a launch part. */
type McpLaunchPart = Extract<LaunchPart, { readonly kind: 'mcp' }>;

/**
 * The `launch.parts` a launch gets from `config/mcp/*.yaml` (§4.9): one `mcp` part per item the harness may run (an
 * item that names a harness is for that harness only). Inert: a part is a name and the item as data. `env` keeps its
 * `${secret:NAME}` references; the Vault opens them for the child at the moment it starts, so no value is here.
 */
export function mcpParts(items: ReadonlyMap<string, McpItem>, harness: HarnessKey): readonly McpLaunchPart[] {
  const parts: McpLaunchPart[] = [];
  for (const [name, item] of [...items].sort(([left], [right]) => left.localeCompare(right))) {
    if (item.harness !== undefined && item.harness !== harness) continue;
    if (item.env !== undefined && !McpEnvSchema.safeParse(item.env).success)
      throw new Error(
        `The MCP server environment is invalid. Store credentials with fy secret set NAME and use \${secret:NAME}.`,
      );
    const { harness: _harness, ...config } = item;
    parts.push({ kind: 'mcp', name, config: config as JsonValue });
  }
  return parts;
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
  /**
   * The item names the launch's runtime profile stack carries (D10). A launch with no runtime, or a runtime whose
   * stack cannot be resolved, carries none.
   */
  layered(runtime: string | undefined): Promise<ReadonlySet<string>>;
  /** The launch's project servers (`ProjectMcpLaunch.share`), after their own renewal. */
  project(spec: Omit<LaunchSpec, 'parts'>): Promise<ProjectMcpLaunchShare>;
}

/**
 * MCP's `launch.parts` source: today's `FleetLaunchEnvironment` and `ProjectMcpLaunch` together, asked per launch.
 *
 * 1. RENEWAL ON USE (today's `launch-environment.ts`): every access token this launch names — a signed-in server's,
 *    and every `${secret:NAME}` an item's `env` names — is made current just before the launch, by the sign-in
 *    service, which never throws. A refresh that fails leaves the old token where it was (the server then says it
 *    needs a new sign-in) and the launch goes ahead.
 * 2. One `mcp` part per item the runtime's profile stack names ({@link mcpParts}); a signed-in one names its `bearer`
 *    VARIABLE (today's `adapt.ts`: Claude renders it as an `Authorization` header, Codex as `bearer_token_env_var`).
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
    // Only the items this runtime's profile stack names, as a v4 runtime home held only its profile's components.
    const layered = await this.deps.layered(spec.runtime);
    const items = new Map([...this.deps.items()].filter(([name]) => layered.has(name)));
    const servers = mcpParts(items, spec.harness);
    const signedIn = new Map<string, McpOAuthSecretNames>();
    const named = new Set<SecretName>();
    for (const part of servers) {
      const item = items.get(part.name);
      if (item === undefined) continue;
      if (item.auth === 'oauth' && item.url !== undefined) {
        const names = mcpOAuthSecretNames(part.name, item.url);
        signedIn.set(part.name, names);
        named.add(names.access);
      }
      for (const value of Object.values(item.env ?? {})) for (const name of secretReferencesIn(value)) named.add(name);
    }
    const [project] = await Promise.all([
      this.deps.project(spec),
      named.size === 0 ? undefined : this.deps.renewal.refreshForLaunch([...named]),
    ]);
    const held = signedIn.size === 0 ? new Set<SecretName>() : await this.deps.held();
    const env: Record<string, string> = { ...project.env };
    const parts: LaunchPart[] = servers.map(part => {
      const names = signedIn.get(part.name);
      if (names === undefined || !held.has(names.access)) return part;
      env[names.variable] = optionalSecretReference(names.access);
      return { ...part, config: { ...(part.config as Record<string, JsonValue>), bearer: names.variable } };
    });
    for (const [name, server] of Object.entries(project.servers))
      parts.push({
        kind: 'mcp',
        name,
        config: { ...server, headers: { ...server.headers }, scope: 'local', project: project.root },
      });
    if (Object.keys(env).length > 0) parts.push({ kind: 'env', env });
    return parts;
  }
}
