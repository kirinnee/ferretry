import { readFile } from 'node:fs/promises';
import { HOME_PORT_FILE, type HomePort, homePortOf } from '../contract/home-port.ts';
import type { RunOverrides } from './arguments.ts';
import { homeOf, resolveSettings, type SettingsOutcome } from './settings.ts';

/** `fyd`'s one import for settings: the pure helpers it prints and filters with, and the one that reads the home. */
export { filterByLevel, renderSettings } from './settings.ts';

/**
 * The home's configured port, read from the one file that owns it (`HOME_PORT_FILE`). A file that is not there says
 * nothing; one that is there and cannot be read is REFUSED by sentence (it only matters to a run that has no `--port`
 * or `FY_PORT`), never skipped over silently: that would bind a port the operator did not choose.
 */
async function readHomePort(home: string): Promise<HomePort> {
  try {
    return homePortOf(await readFile(`${home}/${HOME_PORT_FILE}`, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'refused', sentence: `${HOME_PORT_FILE} cannot be read: ${(error as Error).message}` };
  }
}

/**
 * The composition root's settings: the pure {@link resolveSettings} fed the home's own configured port. The home is
 * decided first (`FY_HOME`), because it is the home's configuration that is read.
 */
export async function settingsForRun(
  env: Readonly<Record<string, string | undefined>>,
  overrides: RunOverrides,
  userHome: string,
): Promise<SettingsOutcome> {
  return resolveSettings(env, overrides, userHome, await readHomePort(homeOf(env, userHome).value));
}
