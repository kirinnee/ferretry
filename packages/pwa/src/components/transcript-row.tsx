import { clockOfInstant } from '../lib/message-clock.ts';
import type { TranscriptEntry } from '../lib/session-screens.ts';
import { PeerMessageRow, SystemNoticeRow } from './agent-message-rows.tsx';
import { CommandRow } from './command-row.tsx';
import { HandoffMessage } from './handoff-message.tsx';
import { LedgerMessage, type SendRetry } from './ledger-message.tsx';
import { Markdown } from './markdown.tsx';
import { useReferenceSurface } from './reference-surface.tsx';
import { MessageFooter } from './send-receipt.tsx';
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
  /** An assistant row follows this one, so a delivered send on it reads as `read`. */
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
  answered = false,
}: TranscriptRowProps) {
  const rhythm = transcriptRhythm(entry, previous);
  if (entry.kind === 'ledger' && entry.ledger !== undefined) {
    return (
      <div className="fy-message fy-message-ledger" data-transcript-kind="ledger" {...rhythm}>
        <LedgerMessage onRetry={onRetry} placement={entry.placement} record={entry.ledger} />
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
  if (entry.kind === 'system') return <SystemNoticeRow entry={entry} rhythm={rhythm} />;
  if (entry.kind === 'user') return <OwnMessageRow answered={answered} entry={entry} rhythm={rhythm} />;
  return <TranscriptTextRow entry={entry} rhythm={rhythm} />;
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
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Record<string, string | undefined>;
  readonly answered: boolean;
}) {
  return (
    <article className="fy-message fy-message-user" data-transcript-kind="user" {...rhythm}>
      <span className="sr-only">You said:</span>
      {entry.handoff === undefined ? (
        <p>{entry.text}</p>
      ) : (
        <HandoffMessage pointer={entry.handoff} pointerText={entry.text} />
      )}
      <MessageFooter answered={answered} clock={clockOfInstant(entry.at)} record={entry.send} side="own" />
    </article>
  );
}

function TranscriptTextRow({
  entry,
  rhythm,
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Record<string, string | undefined>;
}) {
  const label = entry.label ?? defaultLabel(entry.kind);
  const chrome = entry.kind === 'tool' || entry.kind === 'command' || entry.kind === 'notice';

  return (
    <article
      className={`fy-message fy-message-${entry.kind}${chrome ? ' fy-message-chrome' : ''}`}
      data-transcript-kind={entry.kind}
      {...rhythm}
    >
      <header>
        <span>{label}</span>
      </header>
      {entry.kind === 'assistant' ? <AssistantProse text={entry.text} /> : <p>{entry.text}</p>}
      <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
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
  return entry.kind === 'user' || entry.kind === 'assistant' || entry.kind === 'ledger' ? 'message' : 'chrome';
}

function speakerOf(entry: TranscriptEntry): string | undefined {
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
