/** `launch.parts`: every ferret gets Ferretry's `gh` first on its `PATH` (r9 B10), linked project or not. */
import type { LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import type { GhShimFolders } from './shim.ts';

const PLUGIN = 'git-accounts';

/** What a ferret is told about `gh` (one instruction part; the shim's own refusals say the rest). */
export const GH_INSTRUCTION =
  "`gh` here is Ferretry's. In a project linked to GitHub it acts as the linked account (@login). It refuses `auth`, `config`, extensions, aliases, codespaces and any command that checks out or clones: use `git`, which already pushes and signs as @login over SSH. Outside a linked project it says so and does nothing.";

/**
 * The part for one launch. NEVER a token: the pane gets a folder on `PATH`, an empty `GH_CONFIG_DIR`, and a sentence.
 * `GH_TOKEN`, `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` are not named here, and the launch refuses them if they ever were.
 * `folders` answers `undefined` when the shim could not be written: the launch then adds nothing (a `PATH` entry that does
 * not exist would be worse than none).
 */
export function ghShimLaunchParts(folders: () => Promise<GhShimFolders | undefined>): LaunchPartSource {
  return {
    async parts(): Promise<readonly LaunchPart[]> {
      const ready = await folders();
      if (ready === undefined) return [];
      return [
        { kind: 'pane-env', plugin: PLUGIN, env: { GH_CONFIG_DIR: ready.paneConfig }, pathPrepend: [ready.shims] },
        { kind: 'instruction', id: 'git-accounts-gh', text: GH_INSTRUCTION },
      ];
    },
  };
}
