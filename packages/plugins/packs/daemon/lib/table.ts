/**
 * THE PACK TABLE A LEAD READS (`GET /v1/ferrets/:ferretId/pack`, `fy pack`; docs/pack-mode.md). Today's subtree table.
 *
 * Everything here is read from facts the caller hands in — the ferrets Ferrets holds, each one's sitrep lines and its
 * open blockers — in ONE pass, at most {@link PackTableLimits.concurrency} reads at once. THE EXCERPTS ARE MASKED WHOLE
 * BEFORE THEY ARE CUT, in one redaction batch per table, and a redactor that fails withholds every excerpt
 * ({@link readPackTable}). Nothing here reads a secret store itself: `redact` is the kernel's `Redaction.read`.
 *
 * Lineage comes from the ferrets' `parent` links and nothing else: the request names only the root.
 */
import type { FerretState, FerretSummary, SitrepLine } from '@ferretry/core-ferrets/contract';
import { type Instant, InstantSchema, instantFromEpochMs } from '@ferretry/std';
import {
  PACK_ENDED_WINDOW_MS,
  PACK_LAST_LINE_MAX,
  type PackRow,
  type PackRowState,
  type PackTable,
} from '../../contract/index.ts';
import { mapBounded } from './bounded.ts';

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
function ferretsById(ferrets: readonly FerretSummary[]): Map<string, FerretSummary> {
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
function packDepths(byId: ReadonlyMap<string, FerretSummary>, rootId: string): Map<string, number> {
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

/** What a row last said, before it is masked or cut: the whole text. */
interface LastCandidate {
  readonly at: Instant;
  readonly source: 'note' | 'message';
  readonly text: string;
}

/** The newer of a ferret's non-card sitrep lines, in full; a note wins a tie. */
function newestLine(ferret: FerretSummary, lines: readonly SitrepLine[]): LastCandidate | undefined {
  // A line with no time of its own is dated by when the ferret last changed state.
  const changed = InstantSchema.safeParse(ferret.stateAt);
  return lines
    .filter(line => line.kind !== 'card' && line.text.trim() !== '')
    .flatMap((line): LastCandidate[] => {
      const at = line.at ?? (changed.success ? changed.data : undefined);
      return at === undefined
        ? []
        : [{ at, source: line.kind === 'note' ? ('note' as const) : ('message' as const), text: line.text }];
    })
    .reduce<LastCandidate | undefined>(
      (best, next) =>
        best === undefined ||
        Date.parse(next.at) > Date.parse(best.at) ||
        (Date.parse(next.at) === Date.parse(best.at) && next.source === 'note' && best.source !== 'note')
          ? next
          : best,
      undefined,
    );
}

/** The card a ferret works on, from its card sitrep line: the reference it carries and the lane it sits in. */
function cardOf(lines: readonly SitrepLine[]): PackRow['card'] {
  const line = lines.find(candidate => candidate.kind === 'card' && candidate.ref !== undefined);
  return line?.ref === undefined
    ? undefined
    : { ref: line.ref, ...(line.lane === undefined ? {} : { lane: line.lane }) };
}

/** The card's PR, from the same card line. */
function prOf(lines: readonly SitrepLine[]): PackRow['pr'] {
  return lines.find(candidate => candidate.kind === 'card' && candidate.ref !== undefined)?.pr;
}

/** The text shown in place of an excerpt that could not be masked. */
export const EXCERPT_WITHHELD = '[excerpt withheld]';

/** The bounds on one table's excerpt work (today's `SUBTREE_LIMITS`). */
export interface PackTableLimits {
  /** Sitrep reads at the same time. */
  readonly concurrency: number;
  /** Rows that get an excerpt at all; the rest are listed without one. Live rows are served before ended ones. */
  readonly excerptRows: number;
  /** Of those rows, how many may be recently ended ones. */
  readonly endedRows: number;
  /** Excerpt text, in UTF-8 bytes, masked across the whole table. */
  readonly textBytes: number;
  /** Excerpt text, in UTF-8 bytes, for any one row: a longer candidate gets no excerpt rather than a cut one. */
  readonly rowBytes: number;
}

export const PACK_TABLE_LIMITS: PackTableLimits = {
  concurrency: 4,
  excerptRows: 64,
  endedRows: 8,
  textBytes: 8 * 1024 * 1024,
  rowBytes: 1024 * 1024,
};

/**
 * The members that get an excerpt: live ones in tree order up to `excerptRows`, then recently ended ones up to
 * `endedRows` and whatever room is left. Returns their positions in `members`.
 */
function excerptEligible(members: readonly PackMember[], limits: PackTableLimits): ReadonlySet<number> {
  const positions = members.map((_, index) => index);
  const live = positions.filter(index => !isEnded((members[index] as PackMember).ferret));
  const ended = positions.filter(index => isEnded((members[index] as PackMember).ferret));
  const liveChosen = live.slice(0, limits.excerptRows);
  const endedChosen = ended.slice(0, Math.min(limits.endedRows, Math.max(0, limits.excerptRows - liveChosen.length)));
  return new Set([...liveChosen, ...endedChosen]);
}

/** What one table is read from. */
export interface PackTableReads {
  /** The ferret the table is for. */
  readonly root: FerretSummary;
  /** Every ferret that may be in the pack (the root's descendants are found by their parent links). */
  readonly ferrets: readonly FerretSummary[];
  /** One member's sitrep lines and how many open asks name it as their blocker; `undefined` when it has none. */
  sitrep(ferret: string): Promise<{ readonly lines: readonly SitrepLine[]; readonly blockers: number } | undefined>;
  /**
   * Masks every secret in each WHOLE text, in order, under ONE vault open. It rejects when it cannot be sure, and the
   * table then withholds its excerpts rather than show text it did not scrub.
   */
  redact(texts: readonly string[]): Promise<readonly string[]>;
  readonly nowMs: number;
  readonly endedWindowMs?: number;
}

/**
 * The table for `reads.root`: its live pack and the recently ended. THE EXCERPTS ARE MASKED BEFORE THEY ARE CUT (today's
 * `subtree.ts`): each whole candidate goes through ONE redaction batch for the table and only then to one line, because
 * masking after the cut misses a secret that straddles it. If the redactor fails, no excerpt is shown at all
 * ({@link EXCERPT_WITHHELD}), never the raw text. The reads are bounded: {@link PackTableLimits}.
 */
export async function readPackTable(
  reads: PackTableReads,
  limits: PackTableLimits = PACK_TABLE_LIMITS,
): Promise<PackTable> {
  const members = packMembers(reads.ferrets, reads.root.id.trim(), reads.nowMs, reads.endedWindowMs);
  const sitreps = await mapBounded(members, limits.concurrency, async ({ ferret }) => {
    try {
      return await reads.sitrep(ferret.id);
    } catch {
      return undefined;
    }
  });
  const eligible = excerptEligible(members, limits);
  let remaining = limits.textBytes;
  const candidates = members.map((member, index) => {
    if (!eligible.has(index)) return undefined;
    const candidate = newestLine(member.ferret, sitreps[index]?.lines ?? []);
    if (candidate === undefined) return undefined;
    const bytes = new TextEncoder().encode(candidate.text).length;
    if (bytes > limits.rowBytes || bytes > remaining) return undefined;
    remaining -= bytes;
    return candidate;
  });
  const lasts = await excerpts(candidates, reads.redact);
  const rows = members.map(({ ferret, depth }, index): PackRow => {
    const lines = sitreps[index]?.lines ?? [];
    const state = packRowState(ferret.state, sitreps[index]?.blockers ?? 0);
    const parent = parentOf(ferret);
    const card = cardOf(lines);
    const pr = prOf(lines);
    const last = lasts[index];
    return {
      id: ferret.id,
      name: ferret.name,
      ...(parent === undefined ? {} : { parent }),
      depth,
      model: ferret.model ?? 'default',
      state,
      ferretState: ferret.state,
      ...(card === undefined ? {} : { card }),
      ...(pr === undefined ? {} : { pr }),
      ...(last === undefined ? {} : { last }),
      ...(state === 'ended' ? { endedAt: ferret.stateAt } : {}),
    };
  });
  return {
    root: { id: reads.root.id, name: reads.root.name },
    at: instantFromEpochMs(reads.nowMs),
    endedWindowMs: reads.endedWindowMs ?? PACK_ENDED_WINDOW_MS,
    rows,
  };
}

/** Every candidate masked whole in ONE batch, then cut to a line; a redactor that fails withholds them all. */
async function excerpts(
  candidates: readonly (LastCandidate | undefined)[],
  redact: PackTableReads['redact'],
): Promise<PackRow['last'][]> {
  const present = candidates.flatMap((candidate, index) => (candidate === undefined ? [] : [{ candidate, index }]));
  if (present.length === 0) return candidates.map(() => undefined);
  const masked = await redact(present.map(({ candidate }) => candidate.text)).catch(() => undefined);
  const safe = masked?.length === present.length ? masked : undefined;
  const lasts: PackRow['last'][] = candidates.map(() => undefined);
  present.forEach(({ candidate, index }, position) => {
    if (safe === undefined) {
      lasts[index] = { at: candidate.at, source: candidate.source, text: EXCERPT_WITHHELD };
      return;
    }
    const text = oneLine(safe[position] as string);
    lasts[index] = text === '' ? undefined : { at: candidate.at, source: candidate.source, text };
  });
  return lasts;
}
