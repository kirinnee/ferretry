import type { Clock, StateDamage, StateFileDef } from '../../contract/index.ts';
import { beforeFolderName } from '../../contract/index.ts';
import { stateLabel } from './format.ts';
import type { HostFs } from './host-fs.ts';
import { inspectStateFile } from './readers.ts';
import { listCollection, PRIVATE_DIRECTORY_MODE, pluginStateRoot } from './state-port.ts';
import { nodeSqliteFiles, type SqliteFiles } from './sqlite-store.ts';

export interface OpenPluginStateOptions {
  readonly home: string;
  readonly pluginId: string;
  readonly files: readonly StateFileDef[];
  readonly fs: HostFs;
  readonly clock: Pick<Clock, 'now'>;
  /** `core`: a lower format is damaged, always (core formats change only in a major release). */
  readonly kind: 'core' | 'plugin';
  /** Terminals or Browsers with open terminals or pages, or ferrets they run: a reset waits until none are live. */
  readonly liveTargets: boolean;
  readonly sqliteFiles?: SqliteFiles;
}

export interface MoveAside {
  /** `<home>/state/<id>` */
  readonly from: string;
  /** `<home>/state/<id>-before-<YYYY-MM-DD-HHMM>` */
  readonly to: string;
  /** What the notice says. */
  readonly sentence: string;
}

export interface PluginStateOpening {
  /** Every declared file that cannot be used; empty when the plugin may start. */
  readonly damaged: readonly StateDamage[];
  /**
   * Set only when EVERY problem found is a lower format, in a plugin (not core) with no live targets (§9.3): the
   * caller moves the plugin's folder aside with {@link moveStateAside} and the plugin starts empty. Nothing is
   * moved here, and `damaged` then still lists the files, so a caller that does not move reports them.
   */
  readonly moveAside?: MoveAside;
}

/**
 * Boot's look at one plugin's folder (§9.3 "One file at a time"): every declared file, and every file of a
 * declared collection, checked for its format and its schema. Reads nothing it need not (a secret is only looked
 * for), changes nothing, and answers what should happen. The same rules run at every boot.
 */
export async function openPluginState(options: OpenPluginStateOptions): Promise<PluginStateOpening> {
  const { home, pluginId, fs } = options;
  const sqliteFiles = options.sqliteFiles ?? nodeSqliteFiles;
  const root = pluginStateRoot(home, pluginId);
  const damaged: StateDamage[] = [];
  for (const def of options.files) {
    const relatives = def.path.includes('*')
      ? (await listCollection(fs, root, def)).map(name => def.path.replace('*', name))
      : [def.path];
    for (const relative of relatives) {
      const damage = await inspectStateFile(
        fs,
        def,
        `${root}/${relative}`,
        stateLabel(pluginId, relative),
        sqliteFiles,
      );
      if (damage !== undefined) damaged.push(damage);
    }
  }
  const allLower = damaged.length > 0 && damaged.every(damage => damage.reason === 'lower_format');
  if (!allLower || options.kind === 'core' || options.liveTargets) return { damaged };
  const at = new Date(options.clock.now());
  const to = `${home}/state/${beforeFolderName(pluginId, at)}`;
  return {
    damaged,
    moveAside: {
      from: root,
      to,
      sentence: `The saved data of ${pluginId} was written in an older format, so it was moved aside to ${to} and ${pluginId} starts empty. Nothing in it was deleted.`,
    },
  };
}

/**
 * The move itself, kept apart from the decision: `state/<id>` becomes `state/<id>-before-<date>` (`0700`, so it is
 * fenced), and an empty `state/<id>` is made for the plugin to start in. Refuses to overwrite a folder that is
 * already there.
 */
export async function moveStateAside(fs: HostFs, move: Pick<MoveAside, 'from' | 'to'>): Promise<void> {
  if ((await fs.info(move.to)) !== undefined)
    throw new Error(`${move.to} already exists, so ${move.from} was not moved`);
  await fs.rename(move.from, move.to);
  await fs.setMode(move.to, PRIVATE_DIRECTORY_MODE);
  await fs.ensureDirectory(move.from, PRIVATE_DIRECTORY_MODE);
}
