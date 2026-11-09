import { createHash } from 'node:crypto';
import {
  type AsksApi,
  type AskSummary,
  type EntryId,
  EntryIdSchema,
  MACHINE_AGENDA_ID,
  type SourceKey,
} from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { ORPHANS_ENTRY, type OrphanItem } from './lib/orphan-item.ts';
import type {
  AgendaBoardInput,
  WardenAgendaPort,
  WardenAgendaWrite,
  WardenEscalationBoard,
  WardenEscalationRaise,
} from './lib/index.ts';
import type { AgendaSource } from './lib/protocol.ts';
import { parseWardenEscalationSourceRef } from './lib/escalation.ts';

const DAEMON = 'daemon' as SourceKey;
const ONE_LINE = /[\r\n]+/gu;

const oneLine = (text: string, max: number): string => text.replaceAll(ONE_LINE, ' ').trim().slice(0, max) || '-';

/**
 * A per-ferret entry: `f.<ferret>.<sourceRef>`. A ferret id has no `.`, and a notice's ref starts `warden:` (a flag's)
 * or `warden-` (the auto-revive breaker's).
 */
const PER_FERRET = /^f\.([A-Za-z0-9_-]+)\.(warden[:-].+)$/u;

/** Whether a notice is about the machine (one for every ferret the fault names), not about one ferret. */
const isFleetNotice = (sourceRef: string): boolean => parseWardenEscalationSourceRef(sourceRef)?.scope === 'fleet';

/**
 * A warden notice's own identity (`warden:ask:…`) as an Asks entry. Asks is idempotent by `(source, entry)` across
 * EVERY ferret, while today each board was one ferret's own, so a notice about one ferret carries that ferret in its
 * entry (`f.<ferret>.<sourceRef>`): two ferrets stuck the same way are two asks. A machine-wide (`fleet`) notice is
 * one ask whatever board it lands on, so its ref is the entry as it is. Asks takes
 * `[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}`; an entry that fits is used as it is, so the same notice finds itself again after
 * a restart and `refOf` reads the ref back out of it. A longer or odder one is hashed, and remembered for the life of
 * this process so the board can name it back.
 */
export class NoticeEntries {
  private readonly originals = new Map<string, string>();

  entryOf(sourceRef: string, ferret: string): EntryId {
    const key = isFleetNotice(sourceRef) ? sourceRef : `f.${ferret}.${sourceRef}`;
    const direct = EntryIdSchema.safeParse(key);
    if (direct.success) return direct.data;
    const hashed = EntryIdSchema.parse(`w-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`);
    this.originals.set(hashed, sourceRef);
    return hashed;
  }

  refOf(entry: string): string {
    return PER_FERRET.exec(entry)?.[2] ?? this.originals.get(entry) ?? entry;
  }
}

const sourceOf = (ask: AskSummary): AgendaSource => {
  if (ask.kind === 'task') return 'task';
  return ask.source === 'ferret' && ask.kind !== 'notice' ? 'question' : 'agent-raised';
};

/**
 * The warden's notices are Asks: a plain notification the daemon raises on the ferret's own board (`source: daemon`),
 * idempotent by `(source, entry)`. Asks has no update in place, so a notice that already stands is `unchanged`, never
 * `refreshed` (declared GAP: today's refresh of a standing notice's text).
 */
export class AsksWardenAgenda implements WardenAgendaPort {
  constructor(
    private readonly asks: AsksApi,
    private readonly entries: NoticeEntries,
  ) {}

  private async openFor(sessionId: string): Promise<readonly AskSummary[]> {
    return await this.asks.open({ ferret: sessionId as FerretId, state: 'open' });
  }

  async board(sessionId: string): Promise<WardenEscalationBoard | undefined> {
    try {
      const open = await this.openFor(sessionId);
      return {
        sessionId,
        items: open.map(ask => ({
          source: sourceOf(ask),
          sourceRef: ask.source === DAEMON ? this.entries.refOf(ask.entry) : null,
          raisedBy: ask.raisedBy.kind === 'owner' ? 'human' : ask.raisedBy.kind === 'ferret' ? 'agent' : 'daemon',
        })),
      };
    } catch {
      return undefined;
    }
  }

  /** What the agenda view reads: the same open asks, restated as today's board rows. */
  async feed(sessionId: string): Promise<AgendaBoardInput | undefined> {
    try {
      const open = await this.openFor(sessionId);
      return {
        sessionId,
        parseErrors: 0,
        items: open.map(ask => ({
          id: ask.id,
          source: sourceOf(ask),
          subject: ask.subject,
          why: ask.subject,
          waitingSince: ask.raisedAt,
          howToResolve: 'Open the ask and answer it.',
          raisedBy: ask.raisedBy.kind === 'owner' ? 'human' : ask.raisedBy.kind === 'ferret' ? 'agent' : 'daemon',
          ...(ask.source === DAEMON ? { sourceRef: this.entries.refOf(ask.entry) } : {}),
        })),
      };
    } catch {
      return undefined;
    }
  }

  async raise(sessionId: string, request: WardenEscalationRaise): Promise<WardenAgendaWrite> {
    try {
      const entry = this.entries.entryOf(request.sourceRef, sessionId);
      // A ferret's notice stands only on that ferret's board; a machine-wide one stands wherever it was raised.
      const scope = isFleetNotice(request.sourceRef) ? {} : { ferret: sessionId as FerretId };
      const standing = (await this.asks.open({ source: DAEMON, entry, ...scope, state: 'open' })).length > 0;
      if (standing) return 'unchanged';
      await this.asks.notify({
        source: DAEMON,
        entry,
        ref: { ferret: sessionId, kind: request.anomalyKind },
        subject: oneLine(request.subject, 240),
        why: oneLine(request.why, 2_048),
        howToResolve: oneLine(request.howToResolve, 2_048),
        context: request.context,
        raisedBy: { kind: 'daemon' },
        ferret: sessionId,
      });
      return 'created';
    } catch {
      return 'rejected';
    }
  }

  /** A plain notice on one ferret's board that no flag stands behind (the auto-revive breaker's). */
  async notice(
    sessionId: string,
    notice: {
      readonly sourceRef: string;
      readonly subject: string;
      readonly why: string;
      readonly howToResolve: string;
      readonly context: string;
    },
  ): Promise<WardenAgendaWrite> {
    return (await this.noticeOutcome(sessionId, notice)).write;
  }

  /** {@link notice}, and WHY when it was refused (the Asks port's own sentence, such as a full board). */
  async noticeOutcome(
    sessionId: string,
    notice: {
      readonly sourceRef: string;
      readonly subject: string;
      readonly why: string;
      readonly howToResolve: string;
      readonly context: string;
    },
  ): Promise<{ readonly write: WardenAgendaWrite; readonly reason?: string }> {
    try {
      const entry = this.entries.entryOf(notice.sourceRef, sessionId);
      const standing = await this.asks.open({ source: DAEMON, entry, ferret: sessionId as FerretId, state: 'open' });
      if (standing.length > 0) return { write: 'unchanged' };
      await this.asks.notify({
        source: DAEMON,
        entry,
        ref: { ferret: sessionId },
        subject: oneLine(notice.subject, 240),
        why: oneLine(notice.why, 2_048),
        howToResolve: oneLine(notice.howToResolve, 2_048),
        context: notice.context,
        raisedBy: { kind: 'daemon' },
        ferret: sessionId,
      });
      return { write: 'created' };
    } catch (error) {
      return { write: 'rejected', reason: error instanceof Error ? oneLine(error.message, 240) : 'it was refused' };
    }
  }

  /**
   * The ONE item on the machine board that lists every orphaned card nobody can be messaged about
   * (`AsksApi.standing`, keyed `daemon` + `warden.orphans`): the same item while the list changes, nothing written when
   * it is the same. `undefined` closes it. An item that is not open (the owner tapped "Got it") is raised again only
   * for `announce`: a card joined the list. A refusal throws: the sweep says why and tries again next time.
   */
  async standingOrphans(item: OrphanItem | undefined, announce: boolean): Promise<void> {
    const entry = EntryIdSchema.parse(ORPHANS_ENTRY);
    const open = async (): Promise<readonly AskSummary[]> =>
      await this.asks.open({ source: DAEMON, entry, ferret: MACHINE_AGENDA_ID as FerretId, state: 'open' });
    if (item !== undefined) {
      if (!announce && (await open()).length === 0) return;
      await this.asks.standing({
        source: DAEMON,
        entry,
        ref: {},
        subject: oneLine(item.subject, 240),
        why: item.why,
        howToResolve: item.howToResolve,
        context: item.context,
        raisedBy: { kind: 'daemon' },
        ferret: MACHINE_AGENDA_ID,
        blocking: true,
      });
      return;
    }
    for (const ask of await open()) await this.asks.close({ ferret: MACHINE_AGENDA_ID, id: ask.id }, 'source-gone');
  }

  async resolveSource(sessionId: string, source: AgendaSource, sourceRef: string, _note: string): Promise<boolean> {
    if (source !== 'agent-raised') return false;
    try {
      const entry = this.entries.entryOf(sourceRef, sessionId);
      const standing = await this.asks.open({ source: DAEMON, entry, ferret: sessionId as FerretId, state: 'open' });
      for (const ask of standing) await this.asks.close({ ferret: sessionId, id: ask.id }, 'source-gone');
      return standing.length > 0;
    } catch {
      return false;
    }
  }
}
