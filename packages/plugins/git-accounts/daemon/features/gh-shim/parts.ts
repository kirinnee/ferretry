/** `launch.parts`: every ferret gets Ferretry's `gh` first on its `PATH` (r9 B10), linked project or not. */
import type { LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import type { GhShimFolders } from './shim.ts';

const PLUGIN = 'git-accounts';

/** A `GH_CONFIG_DIR` nothing can be read from or written to (`/dev/null` is not a folder): the closed config of a pane that has no shim. */
export const CLOSED_CONFIG = '/dev/null/ferretry-no-gh-config';

/** What a ferret is told when the shim could not be written: `gh` is not available, and the host's is deliberately cut off. */
export const GH_UNAVAILABLE =
  "`gh` is not available in this terminal: Ferretry's gh shim could not be set up, so the machine's own `gh` is cut off from its sign-in on purpose. Use `git` (it pushes and signs as the linked account over SSH). Ask the owner to run `fy doctor`, then restart this ferret.";

/** What a ferret is told about `gh` (one instruction part; the shim's own refusals say the rest). */
export const GH_INSTRUCTION =
  "`gh` here is Ferretry's. In a project linked to GitHub it acts as the linked account (@login). It refuses `auth`, `config`, extensions, aliases, codespaces and any command that checks out or clones: use `git`, which already pushes and signs as @login over SSH. Outside a linked project it says so and does nothing.";

/**
 * The part for one launch. NEVER a token: the pane gets a folder on `PATH`, an empty `GH_CONFIG_DIR`, and a sentence.
 * `GH_TOKEN`, `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` are not named here, and the launch refuses them if they ever were.
 * `folders` answers `undefined` when the shim could not be written. The launch then FAILS CLOSED: no `PATH` entry (a
 * folder that is not there is worse than none), but `GH_CONFIG_DIR` still points where nothing can be read or written, so
 * a host `gh` reached by accident finds neither the host's sign-in nor a place to save one, and the ferret is told in a
 * sentence. It never silently falls back to the host's `gh` and its config.
 */
export function ghShimLaunchParts(folders: () => Promise<GhShimFolders | undefined>): LaunchPartSource {
  return {
    async parts(): Promise<readonly LaunchPart[]> {
      const ready = await folders();
      if (ready === undefined)
        return [
          { kind: 'pane-env', plugin: PLUGIN, env: { GH_CONFIG_DIR: CLOSED_CONFIG } },
          { kind: 'instruction', id: 'git-accounts-gh', text: GH_UNAVAILABLE },
        ];
      return [
        { kind: 'pane-env', plugin: PLUGIN, env: { GH_CONFIG_DIR: ready.paneConfig }, pathPrepend: [ready.shims] },
        { kind: 'instruction', id: 'git-accounts-gh', text: GH_INSTRUCTION },
      ];
    },
  };
}
