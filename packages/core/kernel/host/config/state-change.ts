/**
 * Which config files MOVED between two loads (`ConfigPort.watchState`, the `kernel.config-changed` bus event): the one
 * rule the real config service and the testing host both run, so a file's transitions are the same list on both.
 *
 * A file moved when its state (`absent`, `valid`, `invalid`, `held`) or its disk etag differs from the last load: an
 * edit written or held, a held edit confirmed or discarded, a file broken or fixed, one created or removed. A path the
 * new load does not have is `absent` now; a path the old load did not have was `absent` then. The answer carries the
 * state and the etag only, never a value or a sentence: there is nothing here a caller could quote.
 */
import type { ConfigFileStatus, ConfigStateChange } from '../../contract/ports.ts';
import { ABSENT_CONFIG_ETAG } from './evaluate.ts';

/** Where one file stood at a load: its state and its disk etag. */
export interface ConfigFileStamp {
  readonly state: ConfigFileStatus['state'];
  readonly etag: string;
}

/** One file at a load: its stamp and, for a collection item, its name. */
export interface StampedConfigFile {
  readonly name?: string;
  readonly stamp: ConfigFileStamp;
}

/** A file that moved: where it is (its path under `config/`), and the change its def's listeners hear. */
export interface ConfigFileMove {
  readonly path: string;
  readonly change: ConfigStateChange;
}

/** What a file the load did not find stands at. */
export const ABSENT_STAMP: ConfigFileStamp = Object.freeze({ state: 'absent', etag: ABSENT_CONFIG_ETAG });

/**
 * Every file whose stamp differs between `before` and `after` (keyed by path), in path order: the change is where it
 * stands in `after` (`absent` for a path `after` lacks).
 */
export function configFileMoves(
  before: ReadonlyMap<string, StampedConfigFile>,
  after: ReadonlyMap<string, StampedConfigFile>,
): readonly ConfigFileMove[] {
  const moves: ConfigFileMove[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
    const left = before.get(path);
    const right = after.get(path);
    const was = left?.stamp ?? ABSENT_STAMP;
    const now = right?.stamp ?? ABSENT_STAMP;
    if (was.state === now.state && was.etag === now.etag) continue;
    const name = (right ?? left)?.name;
    moves.push({ path, change: { ...(name === undefined ? {} : { name }), state: now.state, etag: now.etag } });
  }
  return moves;
}

/**
 * The `kernel.config-changed` payload of one move: the plugin, the path, the state and the etag, built field by field
 * so nothing else a caller hands in (a sentence, a value) can ride along.
 */
export function configChangedPayload(
  plugin: string,
  move: ConfigFileMove,
): {
  readonly plugin: string;
  readonly path: string;
  readonly state: ConfigFileStatus['state'];
  readonly etag: string;
} {
  return { plugin, path: move.path, state: move.change.state, etag: move.change.etag };
}
