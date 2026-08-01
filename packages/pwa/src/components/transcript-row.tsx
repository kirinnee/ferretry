import type { TranscriptEntry } from '../lib/session-screens.ts';
import { ToolGroup } from './tool-group.tsx';

export interface TranscriptRowProps {
  readonly entry: TranscriptEntry;
  /** The session is actively working — only a live session can have a tool
   *  still running. */
  readonly live?: boolean;
  /** This row is the final block in the transcript. */
  readonly isLast?: boolean;
}

/**
 * A deliberately asymmetric transcript reading: messages stay legible prose,
 * while tool calls and daemon notices recede into compact chrome. A `tool` row
 * that carries calls renders as the collapsed tool group; richer Markdown and
 * attachments remain owned by later ports.
 */
export function TranscriptRow({ entry, live = false, isLast = false }: TranscriptRowProps) {
  if (entry.kind === 'tool' && entry.tools !== undefined && entry.tools.length > 0) {
    return (
      <div className="fy-message fy-message-tool fy-message-tools" data-transcript-kind="tool">
        <ToolGroup calls={entry.tools} isLast={isLast} live={live} />
      </div>
    );
  }
  return <TranscriptTextRow entry={entry} />;
}

function TranscriptTextRow({ entry }: { readonly entry: TranscriptEntry }) {
  const label = entry.label ?? defaultLabel(entry.kind);
  const timestamp = entry.at === undefined ? undefined : new Date(entry.at);
  const validTimestamp = timestamp !== undefined && Number.isFinite(timestamp.getTime());
  const chrome = entry.kind === 'tool' || entry.kind === 'notice';

  return (
    <article
      className={`fy-message fy-message-${entry.kind}${chrome ? ' fy-message-chrome' : ''}`}
      data-transcript-kind={entry.kind}
    >
      <header>
        <span>{label}</span>
        {validTimestamp ? <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleTimeString()}</time> : null}
      </header>
      <p>{entry.text}</p>
    </article>
  );
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
  }
};
