/**
 * THE SUBTREE TABLE A LEAD READS (docs/pack-mode.md; G24).
 *
 * Everything here is read from what the daemon already holds — the ferret registry and each member's sitrep lines
 * (Board adds its card notes, Conversation the messages a helper sent its lead, through `sitrep.lines`) — in ONE
 * pass, so a lead with fifty descendants costs one registry read and one bounded set of line lookups.
 *
 * THE EXCERPTS ARE REDACTED BEFORE THEY ARE CUT. A note or a message is arbitrary text a ferret wrote, so it can
 * quote a vault secret or a just-typed value; the whole candidate goes through the injected redactor (one batch for
 * the table) and only then to one line, because masking after the cut misses a secret that straddles it. If the
 * redactor fails, no excerpt is shown at all ({@link EXCERPT_WITHHELD}), never the raw text.
 *
 * THE LOOKUPS ARE BOUNDED. At most {@link SubtreeLimits.concurrency} lookups run at once and at most
 * {@link SubtreeLimits.excerptRows} rows (of which {@link SubtreeLimits.endedRows} may be ended ones) get an excerpt.
 * A row past a budget is listed without one; the table never fails for being large. Nothing here writes.
 *
 * Lineage comes from the registry's `parent` links and nothing else: the request names only the root.
 */
import { epochMs, instantFromEpochMs, type Instant } from '@ferretry/std';
import type { FerretId, FerretState, FerretSummary, SitrepLine } from '../../../../contract/index.ts';
import type { FerretRegistry } from '../../registry/registry.ts';
import { mapBounded } from './bounded.ts';

/** How long a stopped helper keeps its row (today's `SUBTREE_ENDED_WINDOW_MS`). */
export const SUBTREE_ENDED_WINDOW_MS = 2 * 60 * 60_000;
/** The longest last line (today's `SUBTREE_LAST_LINE_MAX`). */
export const SUBTREE_LAST_LINE_MAX = 100;

/** The text shown in place of an excerpt that could not be redacted. */
export const EXCERPT_WITHHELD = '[excerpt withheld]';

export type SubtreeState = 'running' | 'waiting' | 'ended';

export interface SubtreeRow {
  readonly id: FerretId;
  readonly name: string;
  readonly parent?: FerretId;
  readonly depth: number;
  readonly state: SubtreeState;
  readonly ferretState: FerretState;
  readonly last?: { readonly at: string; readonly kind: SitrepLine['kind']; readonly text: string };
  readonly endedAt?: string;
}

export interface SubtreeView {
  readonly root: { readonly id: FerretId; readonly name: string };
  readonly at: Instant;
  readonly endedWindowMs: number;
  readonly rows: readonly SubtreeRow[];
}

/** One member of the subtree, in tree order. */
export interface SubtreeMember {
  readonly ferret: FerretSummary;
  readonly depth: number;
}

/** The bounds on one table's excerpt work. */
export interface SubtreeLimits {
  readonly concurrency: number;
  readonly excerptRows: number;
  readonly endedRows: number;
}

export const SUBTREE_LIMITS: SubtreeLimits = { concurrency: 4, excerptRows: 64, endedRows: 8 };

export interface SubtreePorts {
  /** The plugin-added sitrep lines of one ferret (`sitrep.lines`). Read only, never a write. */
  lines(ferret: FerretId): Promise<readonly SitrepLine[]>;
  /**
   * Masks every secret in each text, in order, under ONE vault open. It rejects when it cannot be sure, and the table
   * then withholds its excerpts rather than show text it did not scrub.
   */
  redact(texts: readonly string[]): Promise<readonly string[]>;
  nowMs(): number;
}

const isEnded = (ferret: FerretSummary): boolean => ferret.state === 'stopped';

/** The first non-blank line of `text`, whitespace collapsed and cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number = SUBTREE_LAST_LINE_MAX): string {
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

export function subtreeStateOf(ferret: FerretSummary): SubtreeState {
  if (isEnded(ferret)) return 'ended';
  return ferret.state === 'idle' ? 'waiting' : 'running';
}

/**
 * The descendants to list: every live one, and every one stopped inside `windowMs`, in tree order (a ferret, then
 * its own helpers, then the next sibling; siblings by name). A descendant of a left-out ferret still has its row.
 */
export function subtreeMembers(
  registry: FerretRegistry,
  root: FerretId,
  nowMs: number,
  windowMs: number = SUBTREE_ENDED_WINDOW_MS,
): readonly SubtreeMember[] {
  const depths = registry.depths(root);
  const recent = (ferret: FerretSummary): boolean =>
    !isEnded(ferret) || nowMs - epochMs(ferret.stateAt as Instant) <= windowMs;
  const keyOf = (id: FerretId): readonly string[] => {
    const key: string[] = [];
    const seen = new Set<FerretId>();
    for (let current = registry.summary(id); current && current.id !== root && !seen.has(current.id); ) {
      seen.add(current.id);
      key.unshift(`${current.name.toLowerCase()}\u0000${current.id}`);
      current = current.parent === undefined ? undefined : registry.summary(current.parent);
    }
    return key;
  };
  return [...depths]
    .filter(([id]) => id !== root)
    .flatMap(([id, depth]) => {
      const ferret = registry.summary(id);
      return ferret !== undefined && recent(ferret) ? [{ ferret, depth, key: keyOf(id) }] : [];
    })
    .sort((a, b) => {
      for (let index = 0; index < Math.min(a.key.length, b.key.length); index += 1) {
        const order = (a.key[index] as string).localeCompare(b.key[index] as string);
        if (order !== 0) return order;
      }
      return a.key.length - b.key.length;
    })
    .map(({ ferret, depth }) => ({ ferret, depth }));
}

/** The newest dated line, in full; a tie goes to the earlier source. */
export function newestLine(lines: readonly SitrepLine[]): SitrepLine | undefined {
  return lines.reduce<SitrepLine | undefined>((best, next) => {
    if (next.at === undefined || next.text.trim() === '') return best;
    return best === undefined || epochMs(next.at) > epochMs(best.at as Instant) ? next : best;
  }, undefined);
}

/**
 * The members that get an excerpt: live ones in tree order up to `excerptRows`, then recently ended ones up to
 * `endedRows` and whatever room is left. Returns their positions in `members`.
 */
export function excerptEligible(members: readonly SubtreeMember[], limits: SubtreeLimits): ReadonlySet<number> {
  const positions = members.map((_, index) => index);
  const live = positions.filter(index => !isEnded((members[index] as SubtreeMember).ferret));
  const ended = positions.filter(index => isEnded((members[index] as SubtreeMember).ferret));
  const liveChosen = live.slice(0, limits.excerptRows);
  const endedChosen = ended.slice(0, Math.min(limits.endedRows, Math.max(0, limits.excerptRows - liveChosen.length)));
  return new Set([...liveChosen, ...endedChosen]);
}

export function rowOf(member: SubtreeMember, last: SubtreeRow['last']): SubtreeRow {
  const { ferret, depth } = member;
  const state = subtreeStateOf(ferret);
  return {
    id: ferret.id,
    name: ferret.name,
    ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
    depth,
    state,
    ferretState: ferret.state,
    ...(last === undefined ? {} : { last }),
    ...(state === 'ended' ? { endedAt: ferret.stateAt } : {}),
  };
}

export class SubtreeService {
  constructor(
    private readonly registry: FerretRegistry,
    private readonly ports: SubtreePorts,
    private readonly limits: SubtreeLimits = SUBTREE_LIMITS,
  ) {}

  /** The table for `root`, or `undefined` when no such ferret is in the registry. */
  async view(root: FerretId): Promise<SubtreeView | undefined> {
    const nowMs = this.ports.nowMs();
    const rootFerret = this.registry.summary(root);
    if (rootFerret === undefined) return undefined;
    const members = subtreeMembers(this.registry, root, nowMs);
    const eligible = excerptEligible(members, this.limits);
    const order = [...eligible];
    const found = await mapBounded(order, this.limits.concurrency, async index => {
      try {
        return newestLine(await this.ports.lines((members[index] as SubtreeMember).ferret.id));
      } catch {
        return undefined;
      }
    });
    const candidates: (SitrepLine | undefined)[] = members.map(() => undefined);
    order.forEach((index, position) => {
      candidates[index] = found[position];
    });
    const lasts = await this.excerpts(candidates);
    return {
      root: { id: rootFerret.id, name: rootFerret.name },
      at: instantFromEpochMs(nowMs),
      endedWindowMs: SUBTREE_ENDED_WINDOW_MS,
      rows: members.map((member, index) => rowOf(member, lasts[index])),
    };
  }

  /** Every candidate redacted whole in ONE batch, then cut to a line; a redactor that fails withholds them all. */
  private async excerpts(candidates: readonly (SitrepLine | undefined)[]): Promise<SubtreeRow['last'][]> {
    const present = candidates.flatMap((candidate, index) => (candidate === undefined ? [] : [{ candidate, index }]));
    if (present.length === 0) return candidates.map(() => undefined);
    const redacted = await this.ports.redact(present.map(({ candidate }) => candidate.text)).catch(() => undefined);
    const safe = redacted?.length === present.length ? redacted : undefined;
    const lasts: SubtreeRow['last'][] = candidates.map(() => undefined);
    present.forEach(({ candidate, index }, position) => {
      const at = candidate.at as string;
      if (safe === undefined) {
        lasts[index] = { at, kind: candidate.kind, text: EXCERPT_WITHHELD };
        return;
      }
      const text = oneLine(safe[position] as string);
      lasts[index] = text === '' ? undefined : { at, kind: candidate.kind, text };
    });
    return lasts;
  }
}
