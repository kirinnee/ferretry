import { FERRET_NOTICE_SENTENCES } from '../../../contract/ferret-notice.ts';
import type { AgendaItem, AgendaSnapshot, ResolvedAgendaItem } from '../protocol/agenda.ts';
import { noSuchConversation, noSuchVersion } from '../agenda/service.ts';
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

/**
 * EVERY shape a daemon-raised item's `sourceRef` can have, live or migrated, and whose it is. One table; a shape that
 * is not in it is the Warden's (fail closed), so a producer added later, or a v4 grammar nobody listed, is withheld from
 * a ferret until somebody decides it is not.
 *
 * - `warden`: words a model wrote (an investigator's reason, context, remedy). The Warden raises through the Asks
 *   port as `ask:daemon:<entry>` / `standing:daemon:<entry>`; a v4 home keeps its raw grammar (`warden:…`,
 *   `warden-…`, `warden.…`, `warden-orphan:…`), because the migration carries every item byte unchanged, archives
 *   included, so the classifier reads both.
 * - `other`: a daemon producer whose words are fixed or are not the Warden's: another plugin's Asks source
 *   (`ask:<source>:…`, `standing:<source>:…`), a gate item and its follow-up (`gate:`, `gate-followup:`), a card's agenda
 *   (`card-agenda:`), and the v4 producers named in `DAEMON_SOURCE_REF_PREFIXES` (`lanes:`, `handover:`,
 *   `budget:`, `prompt:`, `question:`). These read as they always have.
 */
interface SourceShape {
  readonly name: string;
  readonly whose: 'warden' | 'other';
  readonly match: RegExp;
}

export const SOURCE_SHAPES: readonly SourceShape[] = [
  { name: 'asks port, daemon source', whose: 'warden', match: /^(?:ask|standing):daemon:/u },
  { name: 'v4 warden notice', whose: 'warden', match: /^warden[:.-]/u },
  { name: 'hashed warden entry', whose: 'warden', match: /^w-[0-9a-f]{40}$/u },
  { name: 'asks port, other source', whose: 'other', match: /^(?:ask|standing):[^:]+:/u },
  { name: 'gate item', whose: 'other', match: /^gate:/u },
  { name: 'gate follow-up', whose: 'other', match: /^gate-followup:/u },
  { name: 'card agenda', whose: 'other', match: /^card-agenda:/u },
  { name: 'v4 lane proposal', whose: 'other', match: /^lanes:/u },
  { name: 'v4 handover', whose: 'other', match: /^handover:/u },
  { name: 'v4 budget notice', whose: 'other', match: /^budget:/u },
  { name: 'v4 console prompt', whose: 'other', match: /^prompt:/u },
  { name: 'v4 harness question', whose: 'other', match: /^question:/u },
];

const OBLIGATION = /^(?:ask|standing):daemon:(.+)$/u;
/** `f.<ferret>.warden:…` / `f.<ferret>.warden-…`: one ferret's notice (a ferret id has no `.`). */
const PER_FERRET = /^f\.([A-Za-z0-9_-]+)\.warden[:-]/u;

/** The ferret a Warden notice names in its entry; `null` when it names none. */
const namedFerret = (sourceRef: string | null): string | null =>
  PER_FERRET.exec((sourceRef === null ? undefined : OBLIGATION.exec(sourceRef)?.[1]) ?? '')?.[1] ?? null;

/**
 * Whether the item is the Warden's by its shape: a listed Warden shape, or a daemon-raised item whose shape is not
 * listed at all (fail closed). A human's or a ferret's item is never the Warden's by shape.
 */
export function isWardenShaped(item: Pick<AgendaItem, 'sourceRef' | 'raisedBy'>): boolean {
  const shape = item.sourceRef === null ? undefined : SOURCE_SHAPES.find(row => row.match.test(item.sourceRef ?? ''));
  if (shape !== undefined) return shape.whose === 'warden';
  return item.raisedBy === 'daemon';
}

/** An item as far as provenance goes: who raised it, in which grammar, and the items it absorbed or came from. */
export type Relative = Sourced & {
  readonly id: string;
  readonly mergedFrom?: readonly string[] | undefined;
  readonly splitFrom?: string | undefined;
};

/**
 * Finds another item of the same board by id: on the board, or, when it has left it, in its newest kept version. `undefined`
 * when the store cannot tell (it never kept it, or could not be read).
 */
export type FindRelative = (id: string) => Promise<Relative | undefined>;

/** How many items one provenance walk looks at: a thread merged and split beyond this is not a thread to trust. */
const MAX_KIN = 64;

/**
 * WARDEN PROVENANCE IS STICKY. A merge keeps the survivor's own `raisedBy` and `sourceRef` but copies the absorbed
 * item's conversation in, and a split starts a new item from an old one, so what an item says can come from an item that was
 * the Warden's (or an investigator's) whatever the item itself looks like. An item therefore counts as the Warden's when it
 * is, or any item merged into it, or the item it was split from (and so on, to the end of the chain), is. A relative the
 * store cannot produce counts as the Warden's: provenance that cannot be told is withheld, not guessed plain.
 * (A provenance field never changes across an item's own versions, so its newest one says what its earlier ones did.)
 */
async function wardenKin(reach: FerretReach | undefined, item: Relative, find: FindRelative): Promise<boolean> {
  const seen = new Set<string>([item.id]);
  const queue: Relative[] = [item];
  while (queue.length > 0 && seen.size <= MAX_KIN) {
    const current = queue.shift() as Relative;
    if (await ownProvenance(reach, current)) return true;
    for (const id of [...(current.mergedFrom ?? []), ...(current.splitFrom === undefined ? [] : [current.splitFrom])]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const relative = await find(id).catch(() => undefined);
      if (relative === undefined) return true;
      queue.push(relative);
    }
  }
  return seen.size > MAX_KIN;
}

/** Whether this item, by itself, is the Warden's: a Warden shape, an unlisted daemon shape, or an investigator's raise. */
async function ownProvenance(reach: FerretReach | undefined, item: Sourced): Promise<boolean> {
  if (isWardenShaped(item)) return true;
  return (
    item.raisedBy === 'agent' &&
    item.raisedBySession !== null &&
    reach !== undefined &&
    (await reach.startedByWarden(item.raisedBySession).catch(() => true))
  );
}

/**
 * What `caller` may read of an item on `board`'s agenda. Without a `reach` the answer for a Warden item is `omit`: a
 * lineage that cannot be read is no lineage.
 */
export async function coverOf(
  reach: FerretReach | undefined,
  caller: string,
  board: string,
  item: Relative,
  find: FindRelative,
): Promise<Cover> {
  if (!(await wardenKin(reach, item, find))) return 'plain';
  if (reach === undefined) return 'omit';
  // A notice names the ferret it is about; one that names none (machine-wide, hashed, raw v4, an investigator's) is about
  // the board it stands on.
  const target = namedFerret(item.sourceRef) ?? board;
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

/** The newest instant an item carries in a field named `waitingSince` or ending `At` (`resolvedAt`, `askedAt`, …). */
const instantsOf = (item: object): string[] =>
  Object.entries(item)
    .filter(([key, value]) => (key === 'waitingSince' || key.endsWith('At')) && typeof value === 'string')
    .map(([, value]) => value as string)
    .filter(value => Number.isFinite(Date.parse(value)));

/** A ferret's board time: the newest instant on the items it may read, else what an empty board answers. */
function visibleUpdatedAt(rows: readonly object[], emptyAt: () => string): string {
  const times = rows.flatMap(instantsOf);
  return times.length === 0
    ? emptyAt()
    : times.reduce((newest, each) => (Date.parse(each) > Date.parse(newest) ? each : newest));
}

/** The rows of a list a ferret may read, projected, in their order. */
async function covered<T extends Relative>(
  rows: readonly T[],
  reach: FerretReach | undefined,
  caller: string,
  board: string,
  find: FindRelative,
  project: (row: T) => T,
): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) {
    const cover = await coverOf(reach, caller, board, row, find);
    if (cover === 'plain') out.push(row);
    else if (cover === 'project') out.push(project(row));
  }
  return out;
}

/**
 * A board as a ferret reads it. The count is the number of items the ferret can see, an answer held for an item it cannot
 * see is not listed, and the order of the rest is the order they had. `updatedAt` is recomputed from the items it can
 * see (the newest instant they carry), so an item it cannot see never moves it; a board with none answers what an empty
 * board answers.
 */
export async function ferretSnapshot(
  reach: FerretReach | undefined,
  caller: string,
  snapshot: AgendaSnapshot,
  /** What an empty board answers as its `updatedAt` (now); used when the ferret may read no item at all. */
  emptyAt: () => string,
  /** Finds an item that is not on this board snapshot (one that has left it): its newest kept version. */
  offBoard: FindRelative,
): Promise<AgendaSnapshot> {
  const onBoard = new Map<string, Relative>([...snapshot.items, ...snapshot.resolved].map(row => [row.id, row]));
  const find: FindRelative = async id => onBoard.get(id) ?? (await offBoard(id));
  const items = await covered(snapshot.items, reach, caller, snapshot.sessionId, find, projectItem);
  const resolved = await covered(snapshot.resolved, reach, caller, snapshot.sessionId, find, projectResolved);
  const shown = new Set([...items, ...resolved].map(row => row.id));
  const held = snapshot.replies === undefined ? undefined : snapshot.replies.pending.filter(id => shown.has(id));
  const sending = snapshot.delivery === undefined ? undefined : snapshot.delivery.sending.filter(id => shown.has(id));
  const { replies: _replies, delivery: _delivery, ...rest } = snapshot;
  return {
    ...rest,
    items,
    resolved,
    count: items.length,
    updatedAt: visibleUpdatedAt([...items, ...resolved], emptyAt),
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

/**
 * What an id that was never raised is answered on each Asks read route, so a Warden item a ferret may not read can be
 * answered the same bytes. The routes take these for an `omit`; `undefined` here means the route has no item at all.
 */
export const ABSENT = {
  /** `GET …/agenda/:id/versions`: no version kept, none seen. */
  versions: (): { readonly versions: readonly []; readonly seen?: undefined } => ({ versions: [] }),
  /** `GET …/agenda/:id/versions/:version`. */
  version: noSuchVersion,
  /** `GET …/agenda/:id/conversation`. */
  conversation: noSuchConversation,
} as const;

/** A Warden item's conversation as a ferret reads it: there is none (the entries of a notice are not the ferret's). */
export const EMPTY_CONVERSATION: AgendaConversationPage = { total: 0, index: 0, offset: 0 };
