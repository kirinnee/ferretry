import { isAbsolute, join, relative, sep } from 'node:path';
import { expandAssetPath } from './paths.ts';

/**
 * THE COMPONENT-SOURCE RULE, AS WRITTEN: whether a fleet component's `file:` or `directory:` names the
 * daemon's own state home in the configuration text itself.
 *
 * A component source may be any document on the machine, but is copied or linked into a runtime's config
 * directory — the model's context — so `file: ~/.ferretry/api-token` would hand the admin token to every agent
 * on that runtime. The configuration check is pure and runs where nothing is resolved (`fy config check` with
 * the daemon stopped), so it can only compare names; it makes the plain case an ERROR so it never comes into
 * effect. Everything a name cannot show — a link, a bind mount, a hard link — is the state-home guard's
 * (`./state-home-guard.ts`), which the provisioner and the body reader go through when they read the source
 * (docs/secrets.md#what-the-state-home-fence-refuses). The fleet's asset tree is the opening: it lives inside
 * the home and is where a relative source is read from.
 */
export interface StateHomeFence {
  /** The daemon's own directories — its state home, then its state and config directories. */
  readonly homes: readonly string[];
  /** Inside a home but open all the same: the fleet's asset tree. */
  readonly open: readonly string[];
}

/** The fence with the state home's key files and folders, which the guard judges by identity wherever they are met. */
export interface PinnedStateHomeFence extends StateHomeFence {
  readonly pinned: readonly string[];
}

/**
 * The state home's fence as the daemon lays the home out under `home` — its state and config directories, the
 * fleet's asset tree open, and its key files and folders pinned: recognised by IDENTITY wherever they are reached, so
 * a bind mount of one alone is still refused. The one list the daemon (the agent file tools, the session-file routes,
 * the start checks, the lease store) and `fy history claim` share (docs/agent-tools.md § The state home); the
 * daemon's own names for each are held to it by `state-home-fence-contract.test.ts`.
 */
export function stateHomeFence(home: string): PinnedStateHomeFence {
  const state = join(home, 'state');
  const fleet = join(home, 'fleet');
  return {
    homes: [home, state, join(home, 'config')],
    open: [join(fleet, 'assets')],
    pinned: [
      join(home, 'api-token'),
      join(home, 'api-warden-token'),
      join(home, 'tmux.sock'),
      ...['secrets.key', 'secrets.json', 'mcp-oauth-secrets.json', 'login-secrets.json', 'passkeys.json'].map(name =>
        join(state, name),
      ),
      join(state, 'daemon-identity.json'),
      fleet,
      join(fleet, 'homes'),
      join(state, 'sessions'),
    ],
  };
}

const within = (directory: string, path: string): boolean => {
  const from = relative(directory, path);
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
};

/** The home that fences `path` by name, or `undefined` when it may be named. */
export function fencedBy(fence: StateHomeFence, path: string): string | undefined {
  if (fence.open.some(directory => within(directory, path))) return undefined;
  return fence.homes.find(directory => within(directory, path));
}

/** What a refused source is told, naming the home and never the file's contents. */
export function fencedSourceMessage(source: string, home: string): string {
  return `${source} is inside this daemon's state home (${home}), which holds this machine's credentials, so no component may copy or link it into a runtime`;
}

/**
 * A fleet component's source: the fence over the state home with the fleet's asset tree open, and what the
 * configuration check needs to expand a reference the way the provisioner will. The provisioner asks the
 * fence of every link hop and the real path at copy time; the check asks it of the reference as written, so
 * a source that names the home never comes into effect.
 */
export interface ComponentSourceRule {
  readonly fence: StateHomeFence;
  /** Expands `~/` and `$HOME/`. */
  readonly userHome: string;
  /** A relative reference is read from here. */
  readonly assetsDirectory: string;
}

/**
 * Why a reference AS WRITTEN may not be a component source, or `undefined` when it may. Lexical: a link on
 * the disk is not seen here, and is refused where the source is read (the provisioner and the body reader).
 */
export function componentSourceProblem(rule: ComponentSourceRule, reference: string): string | undefined {
  const home = fencedBy(rule.fence, expandAssetPath(reference, rule.userHome, rule.assetsDirectory));
  return home === undefined ? undefined : fencedSourceMessage(`"${reference}"`, home);
}
