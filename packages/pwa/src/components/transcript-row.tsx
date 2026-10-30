import { type HandoffPointer, parseFerretryNotice, parsePeerEnvelope } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { handedOverDraft, isOwnSend, ledgerPlacementCopy } from '../lib/ledger-placement.ts';
import { clockOfInstant } from '../lib/message-clock.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import type { AgentRunMark, TranscriptEntry } from '../lib/session-screens.ts';
import { AgendaMessageOr } from './agenda-message.tsx';
import { HandoffNoticeRow, PeerMessageRow, SystemNoticeRow } from './agent-message-rows.tsx';
import { ChatProse } from './chat-prose.tsx';
import { CommandRow } from './command-row.tsx';
import {
  HandoffBody,
  type HandoffReading,
  HandoffVia,
  HandoffViaDetail,
  HandoffView,
  useHandoffReading,
} from './handoff-message.tsx';
import { HarnessEventRow } from './harness-event-row.tsx';
import {
  type LedgerActions,
  LedgerActionsHost,
  LedgerMessage,
  type SendCancel,
  type SendRetry,
  type SendSubmit,
} from './ledger-message.tsx';
import { PackCallRow } from './pack-call.tsx';
import { MessageFooter } from './send-receipt.tsx';
import { SentMessageRow } from './sent-message.tsx';
import { type SendDismiss, type SendExpand, SettledSendNote } from './settled-send-note.tsx';
import { ToolGroup } from './tool-group.tsx';
import { messageImageAlt, TranscriptImages } from './transcript-images.tsx';

export interface TranscriptRowProps {
  readonly entry: TranscriptEntry;
  /** The preceding visible entry controls the transcript's asymmetric rhythm. */
  readonly previous?: TranscriptEntry;
  /** The session is actively working — only a live session can have a tool
   *  still running. */
  readonly live?: boolean;
  /** This row is the final block in the transcript. */
  readonly isLast?: boolean;
  /** Offered on a ledger row, and only when a retry is possible at all. */
  readonly onRetry?: SendRetry;
  /** Offered on a ledger row for a message that was not proven delivered. */
  readonly onCancel?: SendCancel;
  /** Offered on a ledger row, and only a message typed in the composer uses it. */
  readonly onSubmit?: SendSubmit;
  /** Offered on a send that is not delivered: put it away on this device. */
  readonly onDismiss?: SendDismiss;
  /** Opens or folds a settled send's one-line note. */
  readonly onExpand?: SendExpand;
  /** An assistant row follows this one, so a delivered send on it reads as `read`. */
  /** Where an assistant text sits in its run of agent output; only the first names the agent. */
  readonly run?: AgentRunMark | undefined;
  readonly answered?: boolean;
}

/**
 * A deliberately asymmetric transcript reading: assistant messages use the
 * shared rich renderer while human prose stays literal, and tool calls and
 * daemon notices recede into compact chrome. A `tool` row that carries calls
 * renders as the collapsed tool group, and a `command` row as the one-line slash
 * command; attachments remain owned by a later port.
 */
export function TranscriptRow({
  entry,
  previous,
  live = false,
  isLast = false,
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onExpand,
  answered = false,
  run,
}: TranscriptRowProps) {
  const rhythm = transcriptRhythm(entry, previous);
  if (entry.sent !== undefined)
    return <SentMessageRow entry={entry} isLast={isLast} live={live} rhythm={rhythm} sent={entry.sent} />;
  if (entry.pack !== undefined)
    return <PackCallRow entry={entry} isLast={isLast} live={live} pack={entry.pack} rhythm={rhythm} />;
  if (entry.kind === 'ledger' && entry.ledger !== undefined && entry.settled === 'slim')
    return (
      <div className="fy-message fy-message-ledger" data-transcript-kind="ledger" data-settled="slim" {...rhythm}>
        <SettledSendNote onDismiss={onDismiss} onExpand={onExpand} record={entry.ledger} />
      </div>
    );
  const own = ownSendOf(entry);
  if (own !== undefined)
    return (
      <OwnSendRow
        answered={answered}
        entry={entry}
        onCancel={onCancel}
        onCollapse={entry.settled === 'expanded' ? onExpand : undefined}
        onDismiss={onDismiss}
        onRetry={onRetry}
        onSubmit={onSubmit}
        record={own}
        rhythm={rhythm}
      />
    );
  if (entry.kind === 'ledger' && entry.ledger !== undefined) {
    return (
      <div className="fy-message fy-message-ledger" data-transcript-kind="ledger" {...rhythm}>
        <LedgerMessage
          onCancel={onCancel}
          onCollapse={entry.settled === 'expanded' ? onExpand : undefined}
          onDismiss={onDismiss}
          onRetry={onRetry}
          onSubmit={onSubmit}
          placement={entry.placement}
          record={entry.ledger}
        />
      </div>
    );
  }
  if (entry.kind === 'tool' && entry.tools !== undefined && entry.tools.length > 0) {
    return (
      <div className="fy-message fy-message-tool fy-message-tools" data-transcript-kind="tool" {...rhythm}>
        <ToolGroup calls={entry.tools} isLast={isLast} live={live} />
      </div>
    );
  }
  if (entry.kind === 'command' && entry.command !== undefined) {
    return (
      <div className="fy-message fy-message-command" data-transcript-kind="command" {...rhythm}>
        <CommandRow command={entry.command} />
      </div>
    );
  }
  if (entry.kind === 'user' && entry.peer !== undefined)
    return <PeerMessageRow entry={entry} peer={entry.peer} rhythm={rhythm} />;
  if (entry.kind === 'user' && entry.handoff !== undefined)
    return <HandoffRow answered={answered} entry={entry} handoff={entry.handoff} rhythm={rhythm} />;
  if (entry.kind === 'system' && entry.event !== undefined)
    return <HarnessEventRow event={entry.event} rhythm={rhythm} />;
  if (entry.kind === 'system') return <SystemNoticeRow entry={entry} rhythm={rhythm} />;
  if (entry.kind === 'user') return <OwnMessageRow answered={answered} entry={entry} rhythm={rhythm} />;
  return <TranscriptTextRow entry={entry} rhythm={rhythm} run={run} />;
}

/**
 * The reader's own send this row is: the send it travels as (a `ledger` row), or the send a transcript
 * row wears. A teammate's or Ferretry's send keeps its own row shapes.
 */
const ownSendOf = (entry: TranscriptEntry): LedgerSendRecord | undefined => {
  if (entry.kind === 'ledger') return entry.ledger !== undefined && isOwnSend(entry.ledger) ? entry.ledger : undefined;
  if (entry.kind !== 'user' || entry.peer !== undefined || entry.send === undefined) return undefined;
  return isOwnSend(entry.send) ? entry.send : undefined;
};

/** A send on its way has no document to read yet: it is drawn from its own copy until it lands. */
const ON_ITS_WAY: HandoffReading = { state: 'reading' };

/**
 * THE READER'S OWN MESSAGE WHILE THE LEDGER KNOWS IT AS A SEND — on its way, after the conversation, or
 * on the transcript row it became. One component for both, drawn under one key (`sendRowId`), so when
 * the message lands the bubble stays the same element where it is: the words do not change, the time
 * does not change, and only the mark moves on. The controls a travelling send offers fold away, because
 * it is in the conversation now.
 *
 * A message handed over through a FILE reads the same the whole way: the send's own copy of the
 * document while it travels and while the document is read, then the document itself.
 */
function OwnSendRow({
  entry,
  record,
  rhythm,
  answered,
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onCollapse,
}: {
  readonly entry: TranscriptEntry;
  readonly record: LedgerSendRecord;
  readonly rhythm: Record<string, string | undefined>;
  readonly answered: boolean;
  readonly onRetry?: SendRetry | undefined;
  readonly onCancel?: SendCancel | undefined;
  readonly onSubmit?: SendSubmit | undefined;
  readonly onDismiss?: SendDismiss | undefined;
  readonly onCollapse?: SendExpand | undefined;
}) {
  const pointer = entry.kind === 'user' ? entry.handoff : undefined;
  const { reading, source } = useHandoffReading(pointer?.name);
  const draft = handedOverDraft(record);
  const travelling = entry.kind === 'ledger';
  const boundary = travelling ? ledgerPlacementCopy(entry.placement ?? 'chronological') : undefined;
  const viaFile = pointer !== undefined || draft !== undefined;
  return (
    <LedgerActionsHost
      enabled={travelling}
      onCancel={onCancel}
      onCollapse={onCollapse}
      onDismiss={onDismiss}
      onRetry={onRetry}
      onSubmit={onSubmit}
      record={record}
    >
      {actions => (
        <OwnMessageRow
          actions={actions}
          answered={answered}
          entry={entry}
          record={record}
          rhythm={rhythm}
          sendRow={travelling ? 'travelling' : 'landed'}
          viaTurnFile={viaFile && (pointer === undefined || reading.state !== 'gone')}
        >
          {viaFile ? (
            <HandoffView
              draft={draft}
              pointer={pointer}
              pointerText={entry.text}
              reading={pointer === undefined ? ON_ITS_WAY : reading}
              source={source}
            />
          ) : (
            <OwnWords text={travelling ? record.message : entry.text} />
          )}
          {boundary === undefined ? null : (
            <span className="sr-only" data-ledger-boundary>
              {boundary}
            </span>
          )}
        </OwnMessageRow>
      )}
    </LedgerActionsHost>
  );
}

/**
 * A message the agent was handed through a FILE, which is either the reader's own or a ferret's: only
 * the document says which, because a ferret's message carries its banner there. A delivered send that
 * names its sender says so sooner, while the document is still being read, so a ferret's message never
 * flashes up as the reader's own bubble first.
 */
function HandoffRow({
  entry,
  handoff,
  rhythm,
  answered,
}: {
  readonly entry: TranscriptEntry;
  readonly handoff: HandoffPointer;
  readonly rhythm: Record<string, string | undefined>;
  readonly answered: boolean;
}) {
  const { reading, source } = useHandoffReading(handoff.name);
  const notice = reading.state === 'read' ? parseFerretryNotice(reading.handoff.message) : null;
  if (notice !== null) return <HandoffNoticeRow entry={entry} notice={notice} rhythm={rhythm} />;
  const parsed = reading.state === 'read' ? parsePeerEnvelope(reading.handoff.message) : null;
  if (parsed !== null && source !== null && reading.state === 'read')
    return (
      <PeerMessageRow
        body={<HandoffBody handoff={{ ...reading.handoff, message: parsed.body }} source={source} />}
        entry={entry}
        peer={parsed.envelope}
        rhythm={rhythm}
      />
    );
  const sender = entry.send?.from;
  if (sender !== undefined && entry.send !== undefined)
    return (
      <PeerMessageRow
        body={<HandoffView pointer={handoff} pointerText={entry.text} reading={reading} source={source} />}
        entry={entry}
        peer={{
          name: entry.send.fromName ?? sender,
          sessionId: sender,
          kind: entry.send.replyExpected === true ? 'question' : 'message',
          replyExpected: entry.send.replyExpected === true,
          note: '',
        }}
        rhythm={rhythm}
      />
    );
  return (
    <OwnMessageRow answered={answered} entry={entry} rhythm={rhythm} viaTurnFile={reading.state !== 'gone'}>
      <HandoffView pointer={handoff} pointerText={entry.text} reading={reading} source={source} />
    </OwnMessageRow>
  );
}
/**
 * The reader's own message: no "You · 14:02:55" header — the bubble's alignment already says who — and
 * its time and receipt as one small faded line at its foot (`send-receipt.tsx`), on the reader's own
 * clock (`message-clock.ts`). A message the agent was handed through a file shows what the file holds
 * (`handoff-message.tsx`), never the pointer it was typed.
 */
function OwnMessageRow({
  entry,
  rhythm,
  answered,
  children,
  viaTurnFile = false,
  record = entry.send,
  actions,
  sendRow,
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Record<string, string | undefined>;
  readonly answered: boolean;
  /** What the message holds, when it is not `entry.text` — a hand-off's document. */
  readonly children?: ReactNode;
  /** The message travelled as a file: say so on the foot's own line, not on one of its own. */
  readonly viaTurnFile?: boolean;
  /** The send this message is. Its time is when it was SENT, so it reads the same before and after it lands. */
  readonly record?: LedgerSendRecord | undefined;
  /** What a send still on its way offers: its "⋯" button on the foot, and its notes under it. */
  readonly actions?: LedgerActions | undefined;
  /** Whether this bubble is a send on its way or the transcript row it became. */
  readonly sendRow?: 'travelling' | 'landed';
}) {
  const [viaOpen, setViaOpen] = useState(false);
  return (
    <article
      className="fy-message fy-message-user"
      data-send-id={record?.sendId}
      data-send-row={sendRow}
      data-transcript-kind="user"
      {...rhythm}
    >
      <span className="sr-only">You said:</span>
      {children ?? <EntryBody entry={entry} prose={<OwnWords text={entry.text} />} speaker="user" />}
      <MessageFooter
        answered={answered}
        clock={clockOfInstant(record?.acceptedAt) ?? clockOfInstant(entry.at)}
        lead={viaTurnFile ? <HandoffVia onToggle={() => setViaOpen(current => !current)} open={viaOpen} /> : undefined}
        leadDetail={viaTurnFile && viaOpen ? <HandoffViaDetail /> : undefined}
        record={record}
        side="own"
        trailing={actions?.trigger}
      />
      {actions?.panels}
    </article>
  );
}

/**
 * The reader's own words, literal — or, when the daemon worded them about agenda items (an answer from a card, a
 * reply naming `!A45`), the compact agenda card that reads them (`agenda-message.tsx`).
 */
function OwnWords({ text }: { readonly text: string }) {
  return <AgendaMessageOr fallback={<p>{text}</p>} text={text} />;
}

function TranscriptTextRow({
  entry,
  rhythm,
  run,
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Record<string, string | undefined>;
  readonly run?: AgentRunMark | undefined;
}) {
  const label = entry.label ?? defaultLabel(entry.kind);
  const chrome = entry.kind === 'tool' || entry.kind === 'command' || entry.kind === 'notice';

  // Only the first text of a run names the agent; a continuation keeps the name for a screen reader.
  const continued = run?.role === 'continue';
  const footer = <MessageFooter clock={clockOfInstant(entry.at)} side="other" />;
  return (
    <article
      className={`fy-message fy-message-${entry.kind}${chrome ? ' fy-message-chrome' : ''}`}
      data-transcript-kind={entry.kind}
      data-transcript-run={run?.role}
      {...rhythm}
    >
      <header className={continued ? 'sr-only' : undefined}>
        <span>{label}</span>
      </header>
      <EntryBody
        entry={entry}
        prose={entry.kind === 'assistant' ? <AssistantProse text={entry.text} /> : <p>{entry.text}</p>}
        speaker={entry.kind === 'assistant' ? 'assistant' : undefined}
      />
      {run === undefined || run.end ? footer : <div className="fy-run-time">{footer}</div>}
    </article>
  );
}

/**
 * What a message says: its words, and the pictures its log named under them. A row that is only a picture
 * has no empty paragraph above it — the picture is the message.
 */
function EntryBody({
  entry,
  prose,
  speaker,
}: {
  readonly entry: TranscriptEntry;
  readonly prose: ReactNode;
  readonly speaker: 'user' | 'assistant' | undefined;
}) {
  const images = entry.images;
  if (images === undefined || images.length === 0 || speaker === undefined) return prose;
  const alt = messageImageAlt(speaker, entry.label);
  return (
    <>
      {entry.text === '' ? null : prose}
      <TranscriptImages images={images.map(marker => ({ marker, alt }))} />
    </>
  );
}

function transcriptRhythm(
  entry: TranscriptEntry,
  previous: TranscriptEntry | undefined,
): Record<string, string | undefined> {
  const density = densityOf(entry);
  const priorDensity = previous === undefined ? undefined : densityOf(previous);
  const previousSpeaker = previous === undefined ? undefined : speakerOf(previous);
  const speakerChanged =
    density === 'message' &&
    priorDensity === 'message' &&
    speakerOf(entry) !== undefined &&
    speakerOf(entry) !== previousSpeaker;
  return {
    'data-transcript-after': priorDensity,
    'data-transcript-density': density,
    'data-transcript-turn': speakerChanged ? 'true' : undefined,
  };
}

function densityOf(entry: TranscriptEntry): 'message' | 'chrome' {
  // A message this ferret sent, or a sub-ferret it started, is a message, though a tool call carried it.
  if (entry.sent !== undefined || entry.pack !== undefined) return 'message';
  return entry.kind === 'user' || entry.kind === 'assistant' || entry.kind === 'ledger' ? 'message' : 'chrome';
}

function speakerOf(entry: TranscriptEntry): string | undefined {
  if (entry.sent !== undefined || entry.pack !== undefined) return 'assistant';
  // Another agent is its own speaker, so a peer message after yours reads as a change of turn.
  if (entry.kind === 'user' && entry.peer !== undefined) return `peer:${entry.peer.name}`;
  if (entry.kind === 'user' || entry.kind === 'ledger') return 'user';
  return entry.kind === 'assistant' ? 'assistant' : undefined;
}

/**
 * Assistant prose, read through THIS session's reference surface.
 *
 * The surface arrives from context rather than as a prop because a transcript
 * row is rendered by a virtualised list that already threads enough state; a
 * seventh resolver prop per row is how the transcript and the file preview would
 * end up proving references differently. Outside a session workspace the context
 * is empty and reference-shaped text stays prose, which is correct: nothing there
 * can prove a callsign or a path.
 */
function AssistantProse({ text }: { readonly text: string }) {
  return <ChatProse text={text} />;
}

/** What a row with no label of its own is headed by. */
const DEFAULT_LABELS: Readonly<Record<TranscriptEntry['kind'], string>> = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  command: 'Command',
  notice: 'Daemon',
  system: 'Ferretry',
  ledger: 'Send ledger',
};

const defaultLabel = (kind: TranscriptEntry['kind']): string => DEFAULT_LABELS[kind];
