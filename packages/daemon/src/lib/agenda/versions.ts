import type { AgendaConversationEntry, AgendaId, AgendaVersion, AgendaVersionSummary } from '@ferretry/protocol';
import { z } from 'zod';
import { speakerOf } from './item-words.ts';
import type { AgendaActor, AgendaEntry, AgendaLedger, AgendaMutation } from './state-machine.ts';

/**
 * THE VERSIONS OF AN ITEM (docs/agenda.md § Versions): every change that wrote an item keeps the WHOLE item as it was
 * left, numbered from 1, in a sidecar beside the board. The board holds the item as it is now, within the bounds an
 * older app reads (20 history entries, 10 revisions); the sidecar holds how it got there, with no cap.
 *
 * Whole snapshots rather than diffs because a version is read on its own (the app draws any two side by side) and a
 * diff chain is only as good as its oldest link: one lost or unreadable line would corrupt every version after it.
 */

/** One version to keep: the item exactly as a change left it. */
export interface AgendaVersionDraft {
  readonly entry: AgendaEntry;
  /** Durable transaction identity; replay after an uncertain acknowledgement must not append twice. */
  readonly mutationId?: string;
  /** Full thread kept outside the bounded version item, including its exact historical order. */
  readonly conversation?: readonly AgendaConversationEntry[];
  readonly beforeConversation?: readonly AgendaConversationEntry[];
  readonly at: string;
  readonly by: AgendaVersionSummary['by'];
  readonly change: string;
  /** The item as it stood before the change, kept as the item's first version when it has none yet. */
  readonly before?: AgendaEntry;
}

/** The change a never-versioned item is first kept as: it was already on the board before versions were. */
export const CARRIED_VERSION = 'carried';

/** Where versions are kept. Prepared drafts remain durable until every item has acknowledged its write. */
export interface AgendaVersionStore {
  /** Appends in order, deduplicating each item by mutationId. Rejects on a disk failure so recovery can replay. */
  record(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void>;
  list(sessionId: string, id: AgendaId): Promise<readonly AgendaVersionSummary[]>;
  get(sessionId: string, id: AgendaId, version: number): Promise<AgendaVersion | undefined>;
  conversation?(
    sessionId: string,
    id: AgendaId,
    version: number,
  ): Promise<readonly AgendaConversationEntry[] | undefined>;
  /**
   * Voids what a change that never committed recorded: for each draft whose mutation the store holds, the version it
   * made when it is still the item's latest (a draft's own version is always the tail), and the mutation itself.
   * A draft the store never saw, or one that is no longer the tail, changes nothing.
   */
  discard?(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void>;
}

/** No versions are kept: a daemon wired without the sidecar. */
export const NO_AGENDA_VERSIONS: AgendaVersionStore = {
  record: async () => undefined,
  list: async () => [],
  get: async () => undefined,
};

/** Which version of an item each device last opened (`PUT …/seen`). */
export interface AgendaSeenStore {
  seen(sessionId: string, id: AgendaId, deviceId: string): Promise<number | undefined>;
  /** Marks `version` seen; a device that has seen a later version keeps it. Answers the mark that stands. */
  mark(sessionId: string, id: AgendaId, deviceId: string, version: number): Promise<number>;
}

export const NO_AGENDA_SEEN: AgendaSeenStore = {
  seen: async () => undefined,
  mark: async (_session, _id, _device, version) => version,
};

/** Who made a change, as a version names them. */
export const versionAuthor = (actor: AgendaActor): AgendaVersionSummary['by'] => speakerOf(actor);

/**
 * The versions a committed mutation makes: one per entry it touched — the item changed, the item a merge closed, the
 * parent and the child of a split. An entry the mutation left as it was (the same object, or the same JSON) makes none.
 * Pure and total.
 */
export function versionDrafts(
  before: AgendaLedger | null,
  mutation: Extract<AgendaMutation, { ok: true }>,
  by: AgendaVersionSummary['by'],
): readonly AgendaVersionDraft[] {
  if (!mutation.changed || mutation.change === 'unchanged') return [];
  const earlier = new Map((before?.entries ?? []).map(entry => [entry.item.id, entry] as const));
  const drafts: AgendaVersionDraft[] = [];
  for (const entry of mutation.ledger.entries) {
    const was = earlier.get(entry.item.id);
    if (was === entry) continue;
    if (
      was !== undefined &&
      was.lifecycle === entry.lifecycle &&
      JSON.stringify(was.item) === JSON.stringify(entry.item)
    ) {
      continue;
    }
    drafts.push({
      entry,
      conversation: mutation.ledger.conversations?.[entry.item.id] ?? entry.item.conversation ?? [],
      ...(was === undefined
        ? {}
        : { beforeConversation: before?.conversations?.[entry.item.id] ?? was.item.conversation ?? [] }),
      at: mutation.ledger.updatedAt,
      by,
      change: was === undefined ? 'created' : mutation.change,
      ...(was === undefined ? {} : { before: before?.carriedEntries?.[entry.item.id] ?? was }),
    });
  }
  return drafts;
}

const FileItemSchema = z.looseObject({
  id: z.string(),
  waitingSince: z.string(),
  subject: z.string().optional(),
  raisedBy: z.string().optional(),
  history: z.array(z.looseObject({ at: z.string() })).optional(),
  revisions: z.array(z.looseObject({ at: z.string() })).optional(),
  ownerAnswer: z.looseObject({ at: z.string() }).optional(),
  resolvedAt: z.string().optional(),
});
const FileEntrySchema = z.looseObject({ item: FileItemSchema });

/**
 * WHETHER A CHANGE THAT WAS PREPARED REACHED THE AGENDA FILE `text` (docs/agenda.md § Versions), for a file someone else
 * has written since: the one place a committed intent and an uncommitted one look alike. Evidence, per draft, is the
 * same item in the file (its id and `waitingSince`) with the draft's own mark on it. A created item is marked by its
 * subject; any other change by the draft's `at` among the item's history, revisions, owner answer or closing time, with
 * the subject or the raiser unchanged. One agenda file write commits every draft of an intent, so one marked draft
 * means all of them landed, including those that leave no time on the item (a link, a tick).
 *
 * Pure and total: a file that cannot be read is no evidence, and an unmarked change counts as not landed.
 */
export function draftsLanded(text: string | undefined, drafts: readonly AgendaVersionDraft[]): boolean {
  if (text === undefined) return false;
  let entries: unknown[];
  try {
    const document = z.looseObject({ entries: z.array(z.unknown()) }).safeParse(JSON.parse(text));
    if (!document.success) return false;
    entries = document.data.entries;
  } catch {
    return false;
  }
  const items = new Map(
    entries.flatMap(entry => {
      const parsed = FileEntrySchema.safeParse(entry);
      return parsed.success ? [[parsed.data.item.id, parsed.data.item] as const] : [];
    }),
  );
  return drafts.some(draft => {
    const written = draft.entry.item;
    const found = items.get(written.id);
    if (found === undefined || found.waitingSince !== written.waitingSince) return false;
    if (draft.change === 'created') return found.subject === written.subject;
    if (found.subject !== written.subject && found.raisedBy !== written.raisedBy) return false;
    return [
      ...(found.history ?? []).map(entry => entry.at),
      ...(found.revisions ?? []).map(revision => revision.at),
      ...(found.ownerAnswer === undefined ? [] : [found.ownerAnswer.at]),
      ...(found.resolvedAt === undefined ? [] : [found.resolvedAt]),
    ].includes(draft.at);
  });
}
