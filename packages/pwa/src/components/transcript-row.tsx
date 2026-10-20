import { type HandoffPointer, parseFerretryNotice, parsePeerEnvelope } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { clockOfInstant } from '../lib/message-clock.ts';
import type { AgentRunMark, TranscriptEntry } from '../lib/session-screens.ts';
import { HandoffNoticeRow, PeerMessageRow, SystemNoticeRow } from './agent-message-rows.tsx';
import { CommandRow } from './command-row.tsx';
import { HandoffBody, HandoffVia, HandoffViaDetail, HandoffView, useHandoffReading } from './handoff-message.tsx';
import { HarnessEventRow } from './harness-event-row.tsx';
import { LedgerMessage, type SendCancel, type SendRetry, type SendSubmit } from './ledger-message.tsx';
import { Markdown } from './markdown.tsx';
import { PackCallRow } from './pack-call.tsx';
import { useReferenceSurface } from './reference-surface.tsx';
import { MessageFooter } from './send-receipt.tsx';
import { SentMessageRow } from './sent-message.tsx';
import { ToolGroup } from './tool-group.tsx';

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
  answered = false,
  run,
}: TranscriptRowProps) {
  const rhythm = transcriptRhythm(entry, previous);
  if (entry.sent !== undefined)
    return <SentMessageRow entry={entry} isLast={isLast} live={live} rhythm={rhythm} sent={entry.sent} />;
  if (entry.pack !== undefined)
    return <PackCallRow entry={entry} isLast={isLast} live={live} pack={entry.pack} rhythm={rhythm} />;
  if (entry.kind === 'ledger' && entry.ledger !== undefined) {
    return (
      <div className="fy-message fy-message-ledger" data-transcript-kind="ledger" {...rhythm}>
        <LedgerMessage
          onCancel={onCancel}
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
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Record<string, string | undefined>;
  readonly answered: boolean;
  /** What the message holds, when it is not `entry.text` — a hand-off's document. */
  readonly children?: ReactNode;
  /** The message travelled as a file: say so on the foot's own line, not on one of its own. */
  readonly viaTurnFile?: boolean;
}) {
  const [viaOpen, setViaOpen] = useState(false);
  return (
    <article className="fy-message fy-message-user" data-transcript-kind="user" {...rhythm}>
      <span className="sr-only">You said:</span>
      {children ?? <p>{entry.text}</p>}
      <MessageFooter
        answered={answered}
        clock={clockOfInstant(entry.at)}
        lead={viaTurnFile ? <HandoffVia onToggle={() => setViaOpen(current => !current)} open={viaOpen} /> : undefined}
        leadDetail={viaTurnFile && viaOpen ? <HandoffViaDetail /> : undefined}
        record={entry.send}
        side="own"
      />
    </article>
  );
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
      {entry.kind === 'assistant' ? <AssistantProse text={entry.text} /> : <p>{entry.text}</p>}
      {run === undefined || run.end ? footer : <div className="fy-run-time">{footer}</div>}
    </article>
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
 *
 * THE SINGLE `fy-render` OPT-IN. This is the one call site in the product that
 * passes `enableFyRender`, and that is the whole mechanism keeping inline
 * illustrations to an assistant's own message: every other `<Markdown>` surface
 * is inert by not naming the capability, so a `fy-render` fence pasted into a
 * file preview, a report or the composer renders as an escaped code fence with
 * no code on those surfaces at all. `tests/unit/fy-render-opt-in.test.ts` holds
 * the count at one. See `docs/fy-render.md`.
 */
function AssistantProse({ text }: { readonly text: string }) {
  return <Markdown enableFyRender text={text} {...useReferenceSurface()} />;
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
