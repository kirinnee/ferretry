import type { FerretId, FerretRecord, FerretState, FerretSummary, PackId } from '../../../contract/index.ts';

/**
 * WHO EACH FERRET IS, in memory (§2.2): every `state/ferrets/<ferret>/ferret.json` the daemon holds, and the lineage
 * read from their `parent` links. Pure: the daemon half loads it from the state port and writes through it.
 *
 * Lineage has ONE owner, this registry: the agenda, the board, the file reads and the subtree all ask `mayTouch` /
 * `isAncestorOf` here (today's `lib/sub-ferret` directory over `config.parent`), so they cannot disagree about who
 * is whose helper. Nothing here is ever read from a request.
 */

/** Deepest lineage the ancestor walk follows; a longer chain is treated as not an ancestor (today's value). */
export const MAX_LINEAGE_DEPTH = 16;

export interface FerretFilter {
  readonly state?: FerretState;
  readonly parent?: FerretId;
  readonly pack?: PackId;
}

/** What other subsystems and the app read: the record without its format stamp and runner handle. */
export function summaryOf(record: FerretRecord): FerretSummary {
  const { format: _format, handle: _handle, ...summary } = record;
  return summary;
}

export class FerretRegistry {
  private readonly records = new Map<FerretId, FerretRecord>();
  /** Each record's summary, kept beside it: the same object while the record has not moved (R501 reuse). */
  private readonly summaries = new Map<FerretId, FerretSummary>();
  private moved = 0;

  constructor(records: readonly FerretRecord[] = []) {
    for (const record of records) this.put(record);
  }

  /** Bumps on every change; a view keyed by it is current. */
  generation(): number {
    return this.moved;
  }

  get(ferret: FerretId): FerretRecord | undefined {
    return this.records.get(ferret);
  }

  summary(ferret: FerretId): FerretSummary | undefined {
    return this.summaries.get(ferret);
  }

  /** Summaries in creation order (then id), filtered. The same objects while nothing moved. */
  list(filter: FerretFilter = {}): readonly FerretSummary[] {
    return [...this.records.values()]
      .filter(
        record =>
          (filter.state === undefined || record.state === filter.state) &&
          (filter.parent === undefined || record.parent === filter.parent) &&
          (filter.pack === undefined || record.pack === filter.pack),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(record => this.summaries.get(record.id) as FerretSummary);
  }

  put(record: FerretRecord): void {
    this.records.set(record.id, record);
    this.summaries.set(record.id, summaryOf(record));
    this.moved += 1;
  }

  remove(ferret: FerretId): boolean {
    const had = this.records.delete(ferret);
    this.summaries.delete(ferret);
    if (had) this.moved += 1;
    return had;
  }

  /** The ferret that started this one; `undefined` for a lead or an unknown ferret. */
  leadOf(ferret: FerretId): FerretId | undefined {
    return this.records.get(ferret)?.parent;
  }

  /** Direct helpers, in creation order. */
  children(ferret: FerretId): readonly FerretId[] {
    return this.list({ parent: ferret }).map(summary => summary.id);
  }

  /**
   * Whether `ancestor` started `ferret`, directly or through a chain of leads. Fails closed: an unknown ferret, a
   * cycle, or a chain past {@link MAX_LINEAGE_DEPTH} is "no", because this widens authority.
   */
  isAncestorOf(ancestor: FerretId, ferret: FerretId): boolean {
    const seen = new Set<FerretId>([ferret]);
    let current = ferret;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      const lead = this.leadOf(current);
      if (lead === undefined || seen.has(lead)) return false;
      if (lead === ancestor) return true;
      seen.add(lead);
      current = lead;
    }
    return false;
  }

  /** "A ferret touches only its own; a lead also its helpers'": itself, or a ferret of its own lineage. */
  mayTouch(caller: FerretId, target: FerretId): boolean {
    return caller === target || this.isAncestorOf(caller, target);
  }

  /** Every descendant of `root` with its depth (1 = a direct helper), breadth first; a cycle is cut. */
  depths(root: FerretId): ReadonlyMap<FerretId, number> {
    const depths = new Map<FerretId, number>([[root, 0]]);
    const queue: FerretId[] = [root];
    while (queue.length > 0) {
      const current = queue.shift() as FerretId;
      const depth = depths.get(current) ?? 0;
      if (depth >= MAX_LINEAGE_DEPTH) continue;
      for (const child of this.children(current)) {
        if (depths.has(child)) continue;
        depths.set(child, depth + 1);
        queue.push(child);
      }
    }
    return depths;
  }

  /** Whether a name is held by a ferret that is not stopped (a running ferret's name is not reused). */
  nameHolder(name: string): FerretId | undefined {
    const wanted = name.trim().toLowerCase();
    for (const record of this.records.values())
      if (record.name.toLowerCase() === wanted && record.state !== 'stopped') return record.id;
    return undefined;
  }
}
