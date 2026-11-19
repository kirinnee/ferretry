/** The agents' folder over this plugin's own kernel-made `downloads` root: `<home>/state/git-accounts/downloads`. */
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { RunFolder } from '../features/ssh-keys/agents.ts';

type RunRoot = Pick<RootHandle, 'resolve' | 'checkPrivateChain' | 'lstat' | 'remove' | 'publish'>;

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
  };
}
