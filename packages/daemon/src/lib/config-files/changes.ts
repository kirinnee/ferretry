/**
 * The one owner of "the machine's configuration moved" (docs/config-files.md "Live changes").
 *
 * ## One ledger, many sources
 *
 * A screen reads configuration once and then trusts it, so every source of a change must reach the
 * same place or some screen goes stale: a load that finds a file different from the last load (which
 * is every editor — this app, another device, `fy`, an agent, a hand edit the watcher noticed), a
 * route that changes a login's state or a speed-up, a sign-in that finishes on its own. Each of them
 * calls {@link ConfigChangeLedger.announce} with the kinds it moved, and the ledger is the only thing
 * that counts.
 *
 * ## Coalesced, then counted
 *
 * One act often reaches the ledger more than once — an apply writes a file, the read after it loads
 * it, the watcher loads it again — and a reader should refetch once, not three times. Announcements
 * inside {@link CONFIG_CHANGE_COALESCE_MS} are merged into one revision naming every kind any of them
 * named. This is a debounce, armed only by an announcement: nothing here runs on a schedule of its own.
 *
 * ## Per boot
 *
 * The revision is kept in memory and starts at `0`; the epoch names the boot. A reader that sees a new
 * epoch has missed an unknown amount and refetches everything it shows.
 */

import { CONFIG_CHANGE_KINDS, type ConfigChangeKind, type ConfigRevision } from '@ferretry/protocol';
import type { ConfigSnapshot } from './service.ts';

/** How long announcements are merged into one revision. */
const CONFIG_CHANGE_COALESCE_MS = 100;

/** One counted change: the revision it reached and what moved. */
export interface ConfigChange extends ConfigRevision {
  readonly kinds: readonly ConfigChangeKind[];
}

/** Where a change is announced: what every source of a change holds. */
export interface ConfigChangeSink {
  announce(kinds: readonly ConfigChangeKind[]): void;
}

/** The ledger's one timer, injected so a test drives time itself. */
export interface ConfigChangeScheduler {
  after(milliseconds: number, action: () => void): unknown;
}

export class ConfigChangeLedger implements ConfigChangeSink {
  #revision = 0;
  #pending = new Set<ConfigChangeKind>();
  #armed = false;
  readonly #listeners = new Set<(change: ConfigChange) => void>();

  constructor(
    private readonly epoch: string,
    private readonly scheduler: ConfigChangeScheduler,
    private readonly coalesceMs: number = CONFIG_CHANGE_COALESCE_MS,
  ) {}

  /** Where the revision stands now. */
  current(): ConfigRevision {
    return { epoch: this.epoch, revision: this.#revision };
  }

  announce(kinds: readonly ConfigChangeKind[]): void {
    if (kinds.length === 0) return;
    for (const kind of kinds) this.#pending.add(kind);
    if (this.#armed) return;
    this.#armed = true;
    this.scheduler.after(this.coalesceMs, () => this.#count());
  }

  /** Hear every counted change. Answers the unsubscribe. */
  subscribe(listener: (change: ConfigChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #count(): void {
    this.#armed = false;
    const kinds = CONFIG_CHANGE_KINDS.filter(kind => this.#pending.has(kind));
    this.#pending.clear();
    this.#revision += 1;
    const change: ConfigChange = { ...this.current(), kinds };
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch {
        // One reader that throws must not keep the change from every other reader.
      }
    }
  }
}

/** Everything a reader sees about one path, as one comparable string. */
function pathSignature(snapshot: ConfigSnapshot, path: string): string {
  const evaluation = snapshot.evaluation;
  return JSON.stringify([
    snapshot.files.get(path)?.etag ?? null,
    snapshot.unreadable.includes(path),
    evaluation.accepted[path]?.etag ?? null,
    evaluation.pending.filter(item => item.path === path),
    evaluation.issues.filter(issue => issue.path === path),
  ]);
}

function pathsOf(snapshot: ConfigSnapshot): Set<string> {
  const evaluation = snapshot.evaluation;
  return new Set([
    ...snapshot.files.keys(),
    ...snapshot.unreadable,
    ...Object.keys(evaluation.accepted),
    ...evaluation.pending.map(item => item.path),
    ...evaluation.issues.map(issue => issue.path),
  ]);
}

/**
 * Every path whose file, version in effect, held edit or reported issue differs between two loads,
 * sorted. Empty when a load found exactly what the last one did.
 */
export function changedConfigPaths(previous: ConfigSnapshot, next: ConfigSnapshot): readonly string[] {
  const paths = new Set([...pathsOf(previous), ...pathsOf(next)]);
  return [...paths].filter(path => pathSignature(previous, path) !== pathSignature(next, path)).sort();
}
