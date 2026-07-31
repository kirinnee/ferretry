import type { TranscriptEntry } from '../lib/session-screens.ts';

export interface TranscriptRowProps {
  readonly entry: TranscriptEntry;
}

/**
 * A deliberately asymmetric transcript reading: messages stay legible prose,
 * while tool and daemon notices recede into compact chrome. This is the small
 * display contract currently supported by the browser-safe transcript model;
 * richer Markdown, tool groups, and attachments remain owned by later ports.
 */
export function TranscriptRow({ entry }: TranscriptRowProps) {
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
