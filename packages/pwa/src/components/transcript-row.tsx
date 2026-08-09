import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import type { TranscriptEntry } from '../lib/session-screens.ts';
import { LedgerMessage } from './ledger-message.tsx';
import { Markdown } from './markdown.tsx';
import { useReferenceSurface } from './reference-surface.tsx';
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
  /** The instant the row reads its badges against; injectable for tests. */
  readonly asOf?: number;
  /** Offered on a ledger row, and only when a resend is possible at all. */
  readonly onResend?: (record: LedgerSendRecord) => Promise<boolean>;
}

/**
 * A deliberately asymmetric transcript reading: assistant messages use the
 * shared rich renderer while human prose stays literal, and tool calls and
 * daemon notices recede into compact chrome. A `tool` row that carries calls
 * renders as the collapsed tool group; attachments remain owned by a later
 * port.
 */
export function TranscriptRow({ entry, previous, live = false, isLast = false, asOf, onResend }: TranscriptRowProps) {
  const rhythm = transcriptRhythm(entry, previous);
  if (entry.kind === 'ledger' && entry.ledger !== undefined) {
    return (
      <div className="fy-message fy-message-ledger" data-transcript-kind="ledger" {...rhythm}>
        <LedgerMessage asOf={asOf} onResend={onResend} placement={entry.placement} record={entry.ledger} />
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
  return <TranscriptTextRow entry={entry} rhythm={rhythm} />;
}

function TranscriptTextRow({
  entry,
  rhythm,
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Record<string, string | undefined>;
}) {
  const label = entry.label ?? defaultLabel(entry.kind);
  const timestamp = entry.at === undefined ? undefined : new Date(entry.at);
  const validTimestamp = timestamp !== undefined && Number.isFinite(timestamp.getTime());
  const chrome = entry.kind === 'tool' || entry.kind === 'notice';

  return (
    <article
      className={`fy-message fy-message-${entry.kind}${chrome ? ' fy-message-chrome' : ''}`}
      data-transcript-kind={entry.kind}
      {...rhythm}
    >
      <header>
        <span>{label}</span>
        {validTimestamp ? <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleTimeString()}</time> : null}
      </header>
      {entry.kind === 'assistant' ? <AssistantProse text={entry.text} /> : <p>{entry.text}</p>}
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

function speakerOf(entry: TranscriptEntry): 'user' | 'assistant' | undefined {
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

const defaultLabel = (kind: TranscriptEntry['kind']): string => {
  switch (kind) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'tool':
      return 'Tool';
    case 'notice':
      return 'Daemon';
    case 'ledger':
      return 'Send ledger';
  }
};
