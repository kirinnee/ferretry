import { readFile } from 'node:fs/promises';
import { HOME_PORT_DOCUMENT, HOME_PORT_FILE, type HomePort, homePortOf } from '../contract/home-port.ts';
import type { DaemonImplementation } from '../manifest/implement.ts';
import type { RunOverrides } from './arguments.ts';
import { PRODUCT_BINARIES } from './binaries.ts';
import { inEffectConfigReader } from './check-config.ts';
import { homeOf, resolveSettings, type SettingsOutcome } from './settings.ts';
import { createNodeHostFs } from './state/host-fs.ts';

/** `fyd`'s one import for settings: the pure helpers it prints and filters with, and the one that reads the home. */
export { filterByLevel, renderSettings } from './settings.ts';

/** The plugins' manifests, loaded only when a port has to be read from the home. */
export type LoadImplementations = () => Promise<readonly Pick<DaemonImplementation, 'manifest'>[]>;

/**
 * The port the home's configuration has IN EFFECT, decided by the configuration service's own read-only rule
 * (`inEffectConfigReader`): an edit held for the owner is not in effect, a broken file keeps its last good version. The
 * file on disk is looked at only to know there is one, and — when NOTHING is in effect — to refuse a malformed port by
 * sentence rather than bind a port nobody chose. An unreadable file is refused the same way, never skipped over.
 */
async function readHomePort(home: string, load: LoadImplementations): Promise<HomePort> {
  let text: string;
  try {
    text = await readFile(`${home}/${HOME_PORT_FILE}`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'refused', sentence: `${HOME_PORT_FILE} cannot be read.` };
  }
  const claimed = (await load())
    .flatMap(({ manifest }) => (manifest.data?.config ?? []).map(def => ({ plugin: manifest.id, def })))
    .flatMap(({ plugin, def }) => (def.shape === 'file' && def.file === HOME_PORT_DOCUMENT ? [{ plugin, def }] : []))
    .at(0);
  if (claimed === undefined) return { kind: 'none' };
  const reader = inEffectConfigReader({ home, fs: createNodeHostFs(), binary: PRODUCT_BINARIES.client });
  const inEffect = (await reader.inEffect(claimed.plugin, claimed.def)) as
    | { readonly direct?: { readonly port?: number } }
    | undefined;
  if (inEffect === undefined) {
    // Nothing is in effect: the file was never good, or its first edit is held. A malformed port is said; the rest is none.
    const written = homePortOf(text);
    return written.kind === 'refused' ? written : { kind: 'none' };
  }
  const port = inEffect.direct?.port;
  return port === undefined ? { kind: 'none' } : { kind: 'port', port };
}

/**
 * The composition root's settings: the pure {@link resolveSettings} fed the home's configured port. The home is decided
 * first (`FY_HOME`). The configuration is not read at all when `--port` or `FY_PORT` already names the port.
 */
export async function settingsForRun(
  env: Readonly<Record<string, string | undefined>>,
  overrides: RunOverrides,
  userHome: string,
  load: LoadImplementations,
): Promise<SettingsOutcome> {
  const named = overrides.port !== undefined || env.FY_PORT !== undefined;
  const homePort = named ? ({ kind: 'none' } as const) : await readHomePort(homeOf(env, userHome).value, load);
  return resolveSettings(env, overrides, userHome, homePort);
}
