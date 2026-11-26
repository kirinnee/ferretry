/**
 * Ferretry's `gh` on every ferret's `PATH` (r9 B10): a `sh` file named `gh` that checks the installed client and hands its arguments, untouched,
 * to `fy gh -- …`, which asks the daemon to run the real `gh` as the connected account (B9). The ferret never holds a
 * token and a `gh` it finds first on `PATH` is this file.
 *
 * Where it lives: exact managed scopes under this plugin's `agent-homes/gh`, separate from downloads.
 * The folder is `0700` and the
 * file `0755`: the same user (the ferret) runs it, nobody else can write it.
 */
import type { RunFolder } from '../ssh-keys/agents.ts';
import type { BoundProgram } from '@ferretry/kernel/contract';

/** `<run folder>/shims`: put first on every pane's `PATH`. */
const SHIM_FOLDER = 'shims';
const SHIM_NAME = 'gh';
/** The folder `GH_CONFIG_DIR` points at in a pane, so a REAL `gh` reached by accident finds no sign-in (never the host's). */
const PANE_CONFIG_FOLDER = 'pane-gh-config';
/** The pane's config folder: EMPTY, and read-and-search only (`0500`), so a `gh` reached by accident has nothing to read and nowhere to save a sign-in. */
const PANE_CONFIG_MODE = 0o500;

/** One word for `sh`: the name stays plain, anything odd is single-quoted. */
const word = (text: string): string => (/^[A-Za-z0-9_./-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/** The shim's text. Only a bound canonical installed client and its trusted identity verifier are accepted. */
export const shimScript = (client: BoundProgram): string => `#!/bin/sh
if [ -L ${word(client.program)} ] || [ "$(LC_ALL=C ${client.check.argv.map(word).join(' ')} 2>/dev/null)" != ${word(client.check.expected)} ]; then
  printf '%s\\n' 'GitHub client unavailable' >&2
  exit 1
fi
exec ${word(client.program)} gh -- "$@"
`;

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
 * safely (the run folder is not private): the launch then closes the pane's `gh` config instead (`parts.ts`).
 * Written again on every boot and launch, so an edited or removed shim is repaired before the next launch, and the pane's
 * config folder is emptied again too (anything a ferret left in it is removed).
 */
export async function installGhShim(folder: RunFolder, client: BoundProgram): Promise<GhShimFolders | undefined> {
  if (!(await folder.isPrivate())) return undefined;
  await folder.publish(`${SHIM_FOLDER}/${SHIM_NAME}`, shimScript(client), 0o755);
  await folder.emptyDirectory(PANE_CONFIG_FOLDER, PANE_CONFIG_MODE);
  return ghShimFolders(folder);
}
