/** The agents' folder over this plugin's own kernel-made `downloads` root: `<home>/state/git-accounts/downloads`. */
import type { FencedPath, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import type { RunFolder } from '../features/ssh-keys/agents.ts';

type RunRoot = Pick<
  RootHandle,
  'resolve' | 'checkPrivateChain' | 'lstat' | 'remove' | 'publish' | 'makeDirectory' | 'setMode' | 'list'
>;

/** A folder the owner can change while it is being emptied: the mode is only narrowed once it is empty. */
const WORKING_MODE = 0o700;

/**
 * The root's folder IS the run folder, so its path is the same on every run (no kernel port names a state file's path;
 * Terminals finds its tmux socket the same way, a declared gap). Nothing in it is ever listed to a ferret: the root is
 * the plugin's, and a socket, a pinned `known_hosts` and public keys are all it holds.
 */
export function rootRunFolder(root: RunRoot): RunFolder {
  const base = root.resolve('.');
  if (!base.ok) throw new Error('git-accounts: the agent folder could not be located');
  const path = base.value.replace(/\/\.?$/u, '') as FencedPath;
  const at = (name: string): FencedPath => `${path}/${name}` as FencedPath;
  return {
    path,
    isPrivate: async () => {
      try {
        return (await root.checkPrivateChain(path)).ok;
      } catch {
        return false;
      }
    },
    remove: async name => {
      if ((await root.lstat(at(name))) !== undefined) await root.remove(at(name));
    },
    publish: async (name, text, mode) => {
      await root.publish(at(name), new TextEncoder().encode(text), { mode });
    },
    emptyDirectory: async (name, mode) => {
      const folder = at(name);
      if ((await root.lstat(folder)) === undefined) await root.makeDirectory(folder, { mode: WORKING_MODE });
      await root.setMode(folder, WORKING_MODE);
      for (const entry of await root.list(folder)) await root.remove(`${folder}/${entry}` as FencedPath);
      await root.setMode(folder, mode);
    },
  };
}

/**
 * Shim repair owns two EXACT scopes under agent-homes, separate from downloads. Each base is checked against the
 * home anchor; a symlink to a sibling is refused. Removing the config is ONE descriptor-relative tree removal,
 * rather than a list followed by separately resolved removes that a swapped parent could redirect.
 */
export function rootGhShimFolder(roots: Pick<RootsPort, 'root'>): RunFolder {
  const managed = roots.root('agent-homes', { subfolder: 'gh' });
  const shims = roots.root('agent-homes', { subfolder: 'gh/shims' });
  const config = roots.root('agent-homes', { subfolder: 'gh/pane-gh-config' });
  const locate = (root: RootHandle, name = '.'): FencedPath => {
    const found = root.resolve(name);
    if (!found.ok) throw new Error('git-accounts: GitHub client unavailable');
    return found.value;
  };
  const path = locate(managed).replace(/\/\.?$/u, '');
  return {
    path,
    isPrivate: async () => {
      await managed.makeDirectory(locate(managed), { mode: 0o700 });
      return (await managed.checkPrivateChain(locate(managed))).ok;
    },
    remove: async () => {
      throw new Error('git-accounts: shim removal is not supported');
    },
    publish: async (name, text, mode) => {
      if (name !== 'shims/gh') throw new Error('git-accounts: unexpected shim name');
      await shims.publish(locate(shims, 'gh'), new TextEncoder().encode(text), { mode });
    },
    emptyDirectory: async (name, mode) => {
      if (name !== 'pane-gh-config') throw new Error('git-accounts: unexpected config folder');
      // Creating through the scoped base proves it is a plain folder before any recursive removal.
      await config.makeDirectory(locate(config), { mode: 0o700 });
      await managed.setMode(locate(config), 0o700);
      await config.remove(locate(config));
      await config.makeDirectory(locate(config), { mode });
      await managed.setMode(locate(config), mode);
    },
  };
}
