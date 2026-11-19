/**
 * Ferretry's `gh` on every ferret's `PATH` (r9 B10): a two-line `sh` file named `gh` that hands its arguments, untouched,
 * to `fy gh -- …`, which asks the daemon to run the real `gh` as the connected account (B9). The ferret never holds a
 * token and a `gh` it finds first on `PATH` is this file.
 *
 * Where it lives: the folder the plugin already owns for the agents (`RunFolder`, the kernel-made `downloads` root),
 * under `shims/`, so there is one private home and nothing new for the fence to learn about. The folder is `0700` and the
 * file `0755`: the same user (the ferret) runs it, nobody else can write it.
 */
import type { RunFolder } from '../ssh-keys/agents.ts';

/** `<run folder>/shims`: put first on every pane's `PATH`. */
const SHIM_FOLDER = 'shims';
const SHIM_NAME = 'gh';
/** The folder `GH_CONFIG_DIR` points at in a pane, so a REAL `gh` reached by accident finds no sign-in (never the host's). */
const PANE_CONFIG_FOLDER = 'pane-gh-config';
const PANE_CONFIG_NOTE =
  'Ferretry keeps no gh sign-in here. In a project linked to GitHub, `gh` runs as the linked account.\n';

/** One word for `sh`: the name stays plain, anything odd is single-quoted. */
const word = (text: string): string => (/^[A-Za-z0-9_./-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/** The shim's text. `client` is the product's own CLI name (`fy`), found on the pane's `PATH` like every other `fy` call. */
export const shimScript = (client: string): string => `#!/bin/sh\nexec ${word(client)} gh -- "$@"\n`;

export interface GhShimFolders {
  /** `<run folder>/shims`: the folder a pane's `PATH` starts with. */
  readonly shims: string;
  /** The empty `gh` config folder a pane is pointed at. */
  readonly paneConfig: string;
}

export const ghShimFolders = (folder: RunFolder): GhShimFolders => ({
  shims: `${folder.path}/${SHIM_FOLDER}`,
  paneConfig: `${folder.path}/${PANE_CONFIG_FOLDER}`,
});

/**
 * Writes the shim (and the pane's empty config folder) and answers the folders; `undefined` when they cannot be made
 * safely (the run folder is not private), so a launch then adds nothing instead of naming a folder that is not there.
 * Written again on every boot, so a changed `fy` name or a hand-edited shim never survives a restart.
 */
export async function installGhShim(folder: RunFolder, client: string): Promise<GhShimFolders | undefined> {
  if (!(await folder.isPrivate())) return undefined;
  await folder.publish(`${SHIM_FOLDER}/${SHIM_NAME}`, shimScript(client), 0o755);
  await folder.publish(`${PANE_CONFIG_FOLDER}/README`, PANE_CONFIG_NOTE, 0o600);
  return ghShimFolders(folder);
}
