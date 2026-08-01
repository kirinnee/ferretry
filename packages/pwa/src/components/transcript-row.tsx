import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import type { TranscriptEntry } from '../lib/session-screens.ts';
import { LedgerMessage } from './ledger-message.tsx';
import { ToolGroup } from './tool-group.tsx';

export interface TranscriptRowProps {
  readonly entry: TranscriptEntry;
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
 * A deliberately asymmetric transcript reading: messages stay legible prose,
 * while tool calls and daemon notices recede into compact chrome. A `tool` row
 * that carries calls renders as the collapsed tool group; richer Markdown and
 * attachments remain owned by later ports.
 */
export function TranscriptRow({ entry, live = false, isLast = false, asOf, onResend }: TranscriptRowProps) {
  if (entry.kind === 'ledger' && entry.ledger !== undefined) {
    return (
      <div className="fy-message fy-message-ledger" data-transcript-kind="ledger">
        <LedgerMessage asOf={asOf} onResend={onResend} placement={entry.placement} record={entry.ledger} />
      </div>
    );
  }
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
    case 'ledger':
      return 'Send ledger';
  }
};
