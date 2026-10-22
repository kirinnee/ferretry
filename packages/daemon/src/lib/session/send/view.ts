import type { SendRecord as SendRecordView } from '@ferretry/protocol';
import type { ObservedHumanInput, TranscriptWindow } from '../../transcript/types.ts';
import { foldSendEvidenceBatch, type SendEvidenceWatch } from '../observer/send-evidence.ts';
import { drainTranscriptWindow, type SessionTranscriptReader, type TranscriptTarget } from '../transcript/reader.ts';
import type { SendEvidenceReading, SendEvidenceSource } from './tracker.ts';
import type { SendRecord } from './types.ts';

/**
 * A ledger record as the wire carries it.
 *
 * The payload file and the matched text are PRIVATE — paths inside the state home and the exact
 * instruction typed — and never cross the API. A withdrawn record is still served, as a tombstone, so
 * a reader holding the accepted row sees it retract rather than keep its chip forever.
 */
export function sendRecordView(record: SendRecord): SendRecordView {
  const withdrawn = record.fate === 'withdrawn';
  return {
    v: 1,
    sendId: record.sendId,
    acceptedAt: record.acceptedAt,
    acceptedTurn: record.acceptedTurn,
    path: record.path,
    message: record.message,
    attachmentIds: [...(record.attachmentIds ?? [])],
    fate: withdrawn ? 'accepted' : record.fate,
    ...(withdrawn ? { withdrawn: true } : {}),
    ...optional('turn', record.turn),
    ...optional('from', record.from),
    ...optional('fromName', record.fromName),
    ...optional('senderKind', record.senderKind),
    ...optional('replyExpected', record.replyExpected),
    ...optional('held', record.held),
    ...optional('fateAt', record.fateAt),
    ...optional('evidence', record.evidence),
    ...optional('unaccountedReason', record.unaccountedReason),
    ...optional('queuedAt', record.queuedAt),
    ...optional('queueProof', record.queueProof),
    ...optional('attempt', record.attempt),
    ...optional('attemptAt', record.attemptAt),
    ...optional('deadlineAt', record.deadlineAt),
    ...optional('retryable', record.retryable),
    ...optional('typedNotSent', record.typedNotSent),
    ...optional('cancelEffect', record.cancelEffect),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** How far before the oldest watched send a window starts: clocks and record order both drift. */
const WINDOW_MARGIN_MS = 60_000;
/** The sessions whose windows are held at once; a look at any other opens a fresh one. */
const HELD_WINDOWS = 64;
/** The human inputs one held window keeps — far more than a session ever has in flight. */
const HELD_INPUTS = 4_096;

/** One session's open window and what it has seen so far. */
interface HeldWindow {
  readonly window: TranscriptWindow;
  /** The instant, in epoch milliseconds, the window was placed to start from. */
  readonly from: number;
  readonly inputs: readonly ObservedHumanInput[];
  /** The window could not start where it was asked to, so absence before it is unprovable. */
  readonly partial: boolean;
}

/**
 * The tracker's evidence, read through the SAME provenance-resolved transcript reader every other
 * transcript surface uses, so a send is never proven by some other session's file.
 *
 * APPEND-ONLY, FROM THE SEND. A look used to read the transcript from its first byte to a 32 MiB cap,
 * so a conversation larger than that — an adopted one, a long one — was blind to every record a send
 * could be proven by, and every send to it ended "unconfirmed" although the agent had answered. A look
 * now opens a window at the oldest watched send and holds it: each later look reads only what was
 * appended since the last, so its cost is what the agent wrote, never how long the conversation is.
 */
export class TranscriptSendEvidence implements SendEvidenceSource {
  private readonly held = new Map<string, HeldWindow>();

  constructor(
    private readonly target: (id: string) => Promise<TranscriptTarget | undefined>,
    private readonly reader: Pick<SessionTranscriptReader, 'window' | 'file'>,
  ) {}

  async read(id: string, since: string): Promise<SendEvidenceReading> {
    const target = await this.target(id);
    const file = target === undefined ? undefined : await this.reader.file(target);
    if (target === undefined || file === undefined) {
      this.held.delete(id);
      // Told apart because the person's remedy differs: an unproven transcript never becomes readable
      // by waiting, while a proved one that failed to read may on the next look.
      return target === undefined ? { readable: false, inputs: [] } : { readable: false, unbound: true, inputs: [] };
    }
    const from = Date.parse(since) - WINDOW_MARGIN_MS;
    const current = this.held.get(id);
    const held =
      current !== undefined && current.window.file === file && current.from <= from
        ? current
        : await this.open(target, from);
    if (held === undefined) {
      this.held.delete(id);
      return { readable: false, inputs: [] };
    }
    let watch: SendEvidenceWatch = { inputs: held.inputs, blind: held.partial, partial: held.partial };
    const finished = await drainTranscriptWindow(held.window, batch => {
      watch = foldSendEvidenceBatch(watch, batch);
    }).catch(() => false);
    this.hold(id, { ...held, inputs: watch.inputs.slice(-HELD_INPUTS), partial: watch.partial });
    return { readable: finished && !watch.blind, inputs: watch.inputs };
  }

  private async open(target: TranscriptTarget, from: number): Promise<HeldWindow | undefined> {
    const window = await this.reader.window(
      target,
      Number.isFinite(from) ? { at: 'since', instant: new Date(from).toISOString() } : { at: 'beginning' },
    );
    return window === undefined ? undefined : { window, from, inputs: [], partial: false };
  }

  /** Keeps the most recently looked-at windows, so a daemon holding many sessions stays bounded. */
  private hold(id: string, held: HeldWindow): void {
    this.held.delete(id);
    this.held.set(id, held);
    for (const oldest of this.held.keys()) {
      if (this.held.size <= HELD_WINDOWS) break;
      this.held.delete(oldest);
    }
  }
}
