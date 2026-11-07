import { createHash } from 'node:crypto';
import {
  type AsksApi,
  type AskSummary,
  type EntryId,
  EntryIdSchema,
  type SourceKey,
} from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type {
  AgendaBoardInput,
  WardenAgendaPort,
  WardenAgendaWrite,
  WardenEscalationBoard,
  WardenEscalationRaise,
} from './lib/index.ts';
import type { AgendaSource } from './lib/protocol.ts';

const DAEMON = 'daemon' as SourceKey;
const ONE_LINE = /[\r\n]+/gu;

const oneLine = (text: string, max: number): string => text.replaceAll(ONE_LINE, ' ').trim().slice(0, max) || '-';

/**
 * A warden notice's own identity (`warden:ask:…`) as an Asks entry. Asks takes `[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}`; a
 * ref that is already one is used as it is, so the same notice finds itself again after a restart. A longer or odder
 * one is hashed, and remembered for the life of this process so the board can name it back.
 */
export class NoticeEntries {
  private readonly originals = new Map<string, string>();

  entryOf(sourceRef: string): EntryId {
    const direct = EntryIdSchema.safeParse(sourceRef);
    if (direct.success) return direct.data;
    const hashed = EntryIdSchema.parse(`w-${createHash('sha256').update(sourceRef).digest('hex').slice(0, 40)}`);
    this.originals.set(hashed, sourceRef);
    return hashed;
  }

  refOf(entry: string): string {
    return this.originals.get(entry) ?? entry;
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
      const entry = this.entries.entryOf(request.sourceRef);
      const standing = (await this.asks.open({ source: DAEMON, entry, state: 'open' })).length > 0;
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

  async resolveSource(sessionId: string, source: AgendaSource, sourceRef: string, _note: string): Promise<boolean> {
    if (source !== 'agent-raised') return false;
    try {
      const entry = this.entries.entryOf(sourceRef);
      const standing = await this.asks.open({ source: DAEMON, entry, ferret: sessionId as FerretId, state: 'open' });
      for (const ask of standing) await this.asks.close(ask.id, 'source-gone');
      return standing.length > 0;
    } catch {
      return false;
    }
  }
}
