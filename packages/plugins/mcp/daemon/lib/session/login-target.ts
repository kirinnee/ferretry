/**
 * The login half of "add a server for one ferret" (R-0351, R-0352): the runtime a ferret launches on, the profile that
 * runtime launches with, and the two reviewed writes — the MCP item (`config/mcp/<name>.yaml`, this plugin's own file,
 * written through the kernel's config writer) and the one `mcp/<name>` layer in that profile (Runtimes' act, which
 * edits only the profile files that name it). No plugin writes another plugin's file, and Runtimes judges the caller.
 */
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { ProfileLayerOutcome, RuntimeId, RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { McpItem } from '../../../contract/index.ts';
import { type McpLoginTarget, SessionMcpRefusal } from './service.ts';

/** What the login target reads of Runtimes: the runtime, the profiles and the one layer act. */
type LoginRuntimes = Pick<RuntimesApi, 'get' | 'profiles' | 'changeProfileLayers'>;

export interface LoginTargetDeps {
  /** Runtimes, when that plugin is on; `undefined` makes every login add refuse in words (`mcp_runtime_unknown`). */
  readonly runtimes: () => LoginRuntimes | undefined;
  /** Whether `config/mcp/<name>.yaml` holds an item now. */
  readonly hasItem: (name: string) => boolean;
  /** This plugin's own item file, through the kernel's config writer. `ifMatch: 'absent'` is a create. */
  readonly writeItem: (
    name: string,
    patch: Readonly<Record<string, unknown>>,
    ifMatch: 'absent' | undefined,
  ) => Promise<ConfigWriteOutcome>;
}

/** The keys that SAY what a server is: a replaced item loses the old ones, so a url never keeps a stale command. */
const DEFINITION_KEYS = ['command', 'args', 'env', 'url', 'auth', 'oauth'] as const;

const NO_RUNTIMES = 'No runtime can be asked about on this machine yet, so there is no login to add the server to.';

/** The item as a config patch: what it names, and an explicit `undefined` for every definition key it does not. */
function patchOf(item: McpItem): Readonly<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  for (const key of DEFINITION_KEYS) patch[key] = item[key];
  return patch;
}

function itemRefusal(outcome: Exclude<ConfigWriteOutcome, { readonly kind: 'written' }>): SessionMcpRefusal {
  if (outcome.kind === 'held')
    return new SessionMcpRefusal(
      409,
      'mcp_change_held',
      `The server was written but is held for the owner to confirm: ${outcome.sentences.join(' ')}`,
    );
  if (outcome.kind === 'conflict')
    return new SessionMcpRefusal(409, 'mcp_item_changed', 'This server changed since you looked. Preview again.');
  const issues = 'issues' in outcome ? outcome.issues.map(issue => `${issue.path}: ${issue.message}`).join(' ') : '';
  return new SessionMcpRefusal(409, 'mcp_item_refused', `The server was not written. ${issues}`.trim());
}

function layerRefusal(outcome: Exclude<ProfileLayerOutcome, { readonly kind: 'written' }>): SessionMcpRefusal {
  if (outcome.kind === 'held')
    return new SessionMcpRefusal(
      409,
      'mcp_change_held',
      `The profile change is held for the owner to confirm: ${outcome.sentence}`,
    );
  if (outcome.kind === 'conflict')
    return new SessionMcpRefusal(
      409,
      'mcp_profile_changed',
      `The profile ${outcome.profile} changed since you looked. Preview again.`,
    );
  return new SessionMcpRefusal(409, 'mcp_profile_refused', outcome.sentence);
}

/** {@link McpLoginTarget} over Runtimes (reads and the layer act) and this plugin's own item file. */
export function runtimesLoginTarget(deps: LoginTargetDeps): McpLoginTarget {
  const runtimes = (): LoginRuntimes => {
    const held = deps.runtimes();
    if (held === undefined) throw new SessionMcpRefusal(409, 'mcp_runtime_unknown', NO_RUNTIMES);
    return held;
  };
  return {
    runtime: async name => {
      const found = await deps.runtimes()?.get(name as RuntimeId);
      return found === undefined ? undefined : { name: found.id, profile: found.profile };
    },
    profile: async name => {
      const found = (await deps.runtimes()?.profiles())?.find(profile => profile.name === name);
      return found === undefined ? undefined : { name: found.name, layers: found.layers, etag: found.etag };
    },
    hasItem: async name => deps.hasItem(name),
    putItem: async (name, item, create) => {
      const outcome = await deps.writeItem(name, patchOf(item), create ? 'absent' : undefined);
      if (outcome.kind !== 'written') throw itemRefusal(outcome);
    },
    layerProfile: async (profile, layer, governance) => {
      const outcome = await runtimes().changeProfileLayers(
        { kind: 'add', profile: profile.name, layer: layer as `mcp/${string}`, ifMatch: profile.etag },
        governance,
      );
      if (outcome.kind !== 'written') throw layerRefusal(outcome);
    },
  };
}
