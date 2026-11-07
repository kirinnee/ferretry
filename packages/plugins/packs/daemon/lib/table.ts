/**
 * THE PACK TABLE A LEAD READS (`GET /v1/ferrets/:ferretId/pack`, `fy pack`; docs/pack-mode.md). Today's subtree table.
 *
 * Everything here is built from facts the caller hands in — the ferrets Ferrets holds, each one's sitrep lines and its
 * open blockers — in ONE pass. The excerpts are cut to one line; redaction is the route's job (the body is built inside
 * one `Redaction.read`, §7.3), so nothing here reads a secret store.
 *
 * Lineage comes from the ferrets' `parent` links and nothing else: the request names only the root.
 */
import type { FerretState, FerretSummary, SitrepLine } from '@ferretry/core-ferrets/contract';
import { instantFromEpochMs } from '@ferretry/std';
import {
  PACK_ENDED_WINDOW_MS,
  PACK_LAST_LINE_MAX,
  type PackRow,
  type PackRowState,
  type PackTable,
} from '../../contract/index.ts';

/** What one table is built from. */
export interface PackTableFacts {
  /** The ferret the table is for. */
  readonly root: FerretSummary;
  /** Every ferret that may be in the pack (the root's descendants are found by their parent links). */
  readonly ferrets: readonly FerretSummary[];
  /** The sitrep lines the plugins added for one ferret. */
  readonly lines: (ferret: string) => readonly SitrepLine[];
  /** How many open asks name one ferret as their blocker. */
  readonly blockers: (ferret: string) => number;
  readonly nowMs: number;
  readonly endedWindowMs?: number;
}

/** One member of the pack, in tree order. */
export interface PackMember {
  readonly ferret: FerretSummary;
  readonly depth: number;
}

const parentOf = (ferret: FerretSummary): string | undefined => {
  const parent = ferret.parent?.trim();
  return parent ? parent : undefined;
};

/** Ferrets keyed by their trimmed id; the first record of a repeated id wins. */
export function ferretsById(ferrets: readonly FerretSummary[]): Map<string, FerretSummary> {
  const byId = new Map<string, FerretSummary>();
  for (const ferret of ferrets) {
    const id = ferret.id.trim();
    if (id && !byId.has(id)) byId.set(id, ferret);
  }
  return byId;
}

/**
 * Breadth-first walk: every ferret at or under `rootId`, with how deep it sits (the root is 0). The visited set
 * makes a malformed parent cycle terminate.
 */
export function packDepths(byId: ReadonlyMap<string, FerretSummary>, rootId: string): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const ferret of byId.values()) {
    const parent = parentOf(ferret);
    const childId = ferret.id.trim();
    if (!parent || !childId) continue;
    const existing = children.get(parent);
    if (existing) existing.push(childId);
    else children.set(parent, [childId]);
  }
  const depth = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index];
    if (next === undefined) continue;
    if (depth.has(next.id)) continue;
    depth.set(next.id, next.depth);
    for (const child of children.get(next.id) ?? [])
      if (!depth.has(child)) queue.push({ id: child, depth: next.depth + 1 });
  }
  return depth;
}

const isEnded = (ferret: FerretSummary): boolean => ferret.state === 'stopped';

/**
 * The ferrets to list: every live one, and every one that ended inside `windowMs`, in tree order (a ferret, then its
 * own helpers, then the next sibling; siblings by name). An ended ferret with no readable end time cannot be shown to
 * be recent, so it is left out. A descendant of a left-out ferret still has its row.
 */
export function packMembers(
  ferrets: readonly FerretSummary[],
  rootId: string,
  nowMs: number,
  windowMs: number = PACK_ENDED_WINDOW_MS,
): readonly PackMember[] {
  const byId = ferretsById(ferrets);
  const depths = packDepths(byId, rootId);
  const recent = (ferret: FerretSummary): boolean => {
    if (!isEnded(ferret)) return true;
    const endedMs = Date.parse(ferret.stateAt);
    return !Number.isNaN(endedMs) && nowMs - endedMs <= windowMs;
  };
  // Each member's sort key is the names from the root down to it, so comparing keys element by element lists a
  // ferret directly before its own descendants.
  const keyOf = (id: string): readonly string[] => {
    const key: string[] = [];
    for (let current = byId.get(id); current && current.id.trim() !== rootId; ) {
      key.unshift(`${current.name.toLowerCase()}\u0000${current.id}`);
      const parent = parentOf(current);
      current = parent === undefined ? undefined : byId.get(parent);
    }
    return key;
  };
  return [...depths]
    .filter(([id]) => id !== rootId)
    .flatMap(([id, depth]) => {
      const ferret = byId.get(id);
      return ferret !== undefined && recent(ferret) ? [{ ferret, depth, key: keyOf(id) }] : [];
    })
    .sort((a, b) => {
      for (let index = 0; index < Math.min(a.key.length, b.key.length); index += 1) {
        const order = (a.key[index] ?? '').localeCompare(b.key[index] ?? '');
        if (order !== 0) return order;
      }
      return a.key.length - b.key.length;
    })
    .map(({ ferret, depth }) => ({ ferret, depth }));
}

/** The first non-blank line of `text`, whitespace collapsed and cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number = PACK_LAST_LINE_MAX): string {
  const first =
    text
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? '';
  const collapsed = first.replace(/\s+/gu, ' ');
  const characters = [...collapsed];
  return characters.length <= max
    ? collapsed
    : `${characters
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * How a ferret is doing, in a lead's words. `needs-you` is an idle ferret with an open ask naming it as the
 * blocker; `waiting` is an idle one; `running` is starting or working.
 */
export function packRowState(state: FerretState, blockers: number): PackRowState {
  if (state === 'stopped') return 'ended';
  if (state === 'idle') return blockers > 0 ? 'needs-you' : 'waiting';
  return 'running';
}

/** The newer of a ferret's non-card sitrep lines, in full; a note wins a tie. */
function lastOf(ferret: FerretSummary, lines: readonly SitrepLine[]): PackRow['last'] {
  const candidates = lines
    .filter(line => line.kind !== 'card')
    .map(line => ({
      at: line.at ?? ferret.stateAt,
      source: line.kind === 'note' ? ('note' as const) : ('message' as const),
      text: oneLine(line.text),
    }))
    .filter(candidate => candidate.text !== '');
  return candidates.reduce<PackRow['last']>(
    (best, next) =>
      best === undefined ||
      Date.parse(next.at) > Date.parse(best.at) ||
      (Date.parse(next.at) === Date.parse(best.at) && next.source === 'note' && best.source !== 'note')
        ? next
        : best,
    undefined,
  );
}

/** The card a ferret works on, from its card sitrep line (the reference it carries). */
function cardOf(lines: readonly SitrepLine[]): PackRow['card'] {
  const line = lines.find(candidate => candidate.kind === 'card' && candidate.ref !== undefined);
  return line?.ref === undefined ? undefined : { ref: line.ref };
}

/** The table for `facts.root`: its live pack and the recently ended. */
export function buildPackTable(facts: PackTableFacts): PackTable {
  const members = packMembers(facts.ferrets, facts.root.id.trim(), facts.nowMs, facts.endedWindowMs);
  const rows = members.map(({ ferret, depth }): PackRow => {
    const lines = facts.lines(ferret.id);
    const state = packRowState(ferret.state, facts.blockers(ferret.id));
    const parent = parentOf(ferret);
    const card = cardOf(lines);
    const last = lastOf(ferret, lines);
    return {
      id: ferret.id,
      name: ferret.name,
      ...(parent === undefined ? {} : { parent }),
      depth,
      model: ferret.runtime ?? ferret.harness,
      state,
      ferretState: ferret.state,
      ...(card === undefined ? {} : { card }),
      ...(last === undefined ? {} : { last }),
      ...(state === 'ended' ? { endedAt: ferret.stateAt } : {}),
    };
  });
  return {
    root: { id: facts.root.id, name: facts.root.name },
    at: instantFromEpochMs(facts.nowMs),
    endedWindowMs: facts.endedWindowMs ?? PACK_ENDED_WINDOW_MS,
    rows,
  };
}
