import { FERRET_NOTICE_SENTENCES } from '../../../contract/ferret-notice.ts';
import type { AgendaItem, AgendaSnapshot, ResolvedAgendaItem } from '../protocol/agenda.ts';
import type { AgendaConversationPage, AgendaVersion } from '../protocol/agenda-versions.ts';

/**
 * What a FERRET caller reads of a Warden-sourced item on an Asks board: classification, times and fixed sentences, and
 * nothing a model wrote. ONE projection for every read route (the board, one item, its versions, one version, its
 * conversation, and the board a write answers with); no route has a copy of it.
 *
 * WHY. A Warden notice keeps the investigator's reason, context and remedy on the board it was raised on, and the per-ferret
 * board reads are open to any ferret (v4 parity: who may read a board is Asks' authorization, not this projection's).
 * Whose subject each sentence of LLM-written text is cannot be proved, so a ferret reads none of it, the same rule the
 * Warden's own routes hold (`ferret-view.ts` there): an item of the caller's own lineage reads as the fixed sentences
 * below, and one about another lineage is not there at all (the item, its versions and its conversation, and no count
 * or order of the rest shows a gap). The owner and a paired device read everything, byte for byte as before, and an item
 * the Warden did not raise is unchanged for everyone.
 *
 * WHICH ITEMS. The Warden raises through the Asks port as source `daemon`, entry `f.<ferret>.warden:…` (one ferret's
 * flag), `warden:ask:fleet:…` or `warden…` (a machine-wide notice) or `w-<hash>` (an entry too long to keep, hashed), as
 * `ask:` or `standing:`. A session the Warden started (origin `warden`: an investigator) that raised an item on a board
 * is the Warden's too. The sentences are the contract's (`FERRET_NOTICE_SENTENCES`), the same ones the Warden's own
 * ferret views say.
 *
 * DENY BY DEFAULT. A projected item is BUILT from the fields named here, never the item with some taken away: a field
 * an item gains later is absent for a ferret until it is listed.
 */

/** Who is in whose lineage, and who the Warden started: read from Ferrets at each call, never from the request. */
export interface FerretReach {
  /** Whether `caller` is `target` or one of its leads (`mayTouch`): the same rule every ferret-facing route holds. */
  mayTouch(caller: string, target: string): Promise<boolean>;
  /** Whether the ferret is one the Warden started (an investigator). */
  startedByWarden(ferret: string): Promise<boolean>;
}

/** What a ferret caller may read of one item. */
export type Cover = 'plain' | 'project' | 'omit';

type Sourced = Pick<AgendaItem, 'sourceRef' | 'raisedBy' | 'raisedBySession'>;

const OBLIGATION = /^(?:ask|standing):daemon:(.+)$/u;
/** `f.<ferret>.warden:…` / `f.<ferret>.warden-…`: one ferret's notice (a ferret id has no `.`). */
const PER_FERRET = /^f\.([A-Za-z0-9_-]+)\.warden[:-]/u;
/** A machine-wide notice (`warden:ask:fleet:…`, `warden.orphans`, `warden-…`) and an entry the Warden hashed. */
const MACHINE_OR_HASHED = /^(?:warden[:.-]|w-[0-9a-f]{40}$)/u;

/** The ferret a Warden notice names in its entry; `null` for a Warden item that names none; `undefined` when it is not the Warden's. */
export function wardenNoticeTarget(sourceRef: string | null): string | null | undefined {
  const entry = sourceRef === null ? undefined : OBLIGATION.exec(sourceRef)?.[1];
  if (entry === undefined) return undefined;
  const named = PER_FERRET.exec(entry)?.[1];
  if (named !== undefined) return named;
  return MACHINE_OR_HASHED.test(entry) ? null : undefined;
}

/**
 * What `caller` may read of an item on `board`'s agenda. Without a `reach` the answer for a Warden item is `omit`: a
 * lineage that cannot be read is no lineage.
 */
export async function coverOf(
  reach: FerretReach | undefined,
  caller: string,
  board: string,
  item: Sourced,
): Promise<Cover> {
  const named = wardenNoticeTarget(item.sourceRef);
  const byInvestigator =
    named === undefined &&
    item.raisedBy === 'agent' &&
    item.raisedBySession !== null &&
    reach !== undefined &&
    (await reach.startedByWarden(item.raisedBySession).catch(() => true));
  if (named === undefined && !byInvestigator) return 'plain';
  if (reach === undefined) return 'omit';
  // A notice names the ferret it is about; one that names none (machine-wide, hashed, an investigator's) is about the
  // board it stands on.
  const target = named ?? board;
  return (await reach.mayTouch(caller, target).catch(() => false)) ? 'project' : 'omit';
}

const pick = (source: object, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(
    keys
      .filter(key => (source as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, (source as Record<string, unknown>)[key]]),
  );

/** An active item: its identity, class and times; the words are the fixed ones. */
const ITEM_FIELDS = [
  'id',
  'source',
  'waitingSince',
  'kind',
  'notice',
  'ping',
  'stage',
  'stages',
  'raisedBy',
  'raisedBySession',
  'raisedByName',
] as const;
/** A resolved item adds when and how it ended; not the note or the answer text. */
const RESOLVED_FIELDS = [...ITEM_FIELDS, 'resolvedAt', 'disposition'] as const;

export const projectItem = (item: AgendaItem): AgendaItem =>
  ({ ...pick(item, ITEM_FIELDS), sourceRef: null, ...FERRET_NOTICE_SENTENCES }) as unknown as AgendaItem;

export const projectResolved = (item: ResolvedAgendaItem): ResolvedAgendaItem =>
  ({
    ...pick(item, RESOLVED_FIELDS),
    sourceRef: null,
    resolutionNote: null,
    ...FERRET_NOTICE_SENTENCES,
  }) as unknown as ResolvedAgendaItem;

/** The rows of a list a ferret may read, projected, in their order. */
async function covered<T extends Sourced & { readonly id: string }>(
  rows: readonly T[],
  reach: FerretReach | undefined,
  caller: string,
  board: string,
  project: (row: T) => T,
): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) {
    const cover = await coverOf(reach, caller, board, row);
    if (cover === 'plain') out.push(row);
    else if (cover === 'project') out.push(project(row));
  }
  return out;
}

/**
 * A board as a ferret reads it. The count is the number of items the ferret can see, an answer held for an item it cannot
 * see is not listed, and the order of the rest is the order they had.
 */
export async function ferretSnapshot(
  reach: FerretReach | undefined,
  caller: string,
  snapshot: AgendaSnapshot,
): Promise<AgendaSnapshot> {
  const items = await covered(snapshot.items, reach, caller, snapshot.sessionId, projectItem);
  const resolved = await covered(snapshot.resolved, reach, caller, snapshot.sessionId, projectResolved);
  const shown = new Set([...items, ...resolved].map(row => row.id));
  const held = snapshot.replies === undefined ? undefined : snapshot.replies.pending.filter(id => shown.has(id));
  const sending = snapshot.delivery === undefined ? undefined : snapshot.delivery.sending.filter(id => shown.has(id));
  const { replies: _replies, delivery: _delivery, ...rest } = snapshot;
  return {
    ...rest,
    items,
    resolved,
    count: items.length,
    ...(snapshot.replies === undefined || held === undefined || held.length === 0
      ? {}
      : { replies: { ...snapshot.replies, pending: held } }),
    ...(snapshot.delivery === undefined || sending === undefined
      ? {}
      : { delivery: { ...snapshot.delivery, sending } }),
  };
}

/** One version as a ferret reads it: the item inside it projected, the summary fields (who, when, what kind) as they are. */
export function ferretVersion(version: AgendaVersion): AgendaVersion {
  const body = version as AgendaVersion & { readonly item?: AgendaItem | ResolvedAgendaItem };
  if (body.item === undefined) return version;
  const resolved = 'resolvedAt' in body.item;
  return {
    ...version,
    item: resolved ? projectResolved(body.item as ResolvedAgendaItem) : projectItem(body.item as AgendaItem),
  } as AgendaVersion;
}

/** A Warden item's conversation as a ferret reads it: there is none (the entries of a notice are not the ferret's). */
export const EMPTY_CONVERSATION: AgendaConversationPage = { total: 0, index: 0, offset: 0 };
