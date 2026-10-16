import { displayCallsign } from '../lib/callsign.ts';
import type { PeerFrom } from '../lib/peer-message.ts';
import type { TranscriptEntry } from '../lib/session-screens.ts';
import { Markdown } from './markdown.tsx';
import { useReferenceSurface } from './reference-surface.tsx';
import { MessageFooter } from './send-receipt.tsx';

/**
 * The two transcript rows that arrive on the user channel but are NOT the person speaking.
 *
 * A PEER MESSAGE reads as a message FROM that agent: a monogram and name chip ("Torrey →"), the
 * sender as a `:torrey` reference (docs/reference-standard.md) through the one renderer so it proves
 * and opens like any other, the message itself as Markdown, and the banner's delivery boilerplate
 * folded away — it is addressed to the receiving agent, not to the person reading. A parked sender
 * says so, because "somebody is blocked on this" is the one part of the boilerplate a reader needs.
 *
 * A FERRETRY NOTICE — a message this machine typed into the session itself, such as a send that did
 * not arrive — is a compact system line, never a "You" bubble the person would not recognise.
 */

type Rhythm = Record<string, string | undefined>;

export function PeerMessageRow({
  entry,
  peer,
  rhythm,
}: {
  readonly entry: TranscriptEntry;
  readonly peer: PeerFrom;
  readonly rhythm: Rhythm;
}) {
  const surface = useReferenceSurface();
  const name = displayCallsign(peer.name);
  return (
    <article className="fy-message fy-message-peer" data-peer={peer.name} data-transcript-kind="user" {...rhythm}>
      <header>
        <span className="fy-peer-chip">
          <span aria-hidden="true" className="fy-peer-avatar">
            {name.charAt(0)}
          </span>
          <span className="fy-peer-name">
            {name}
            <span aria-hidden="true"> →</span>
            <span className="sr-only"> sent this</span>
          </span>
        </span>
        <Markdown className="fy-peer-reference" text={`:${peer.name}`} {...surface} />
        {peer.replyExpected ? <span className="fy-peer-awaiting">waiting for a reply</span> : null}
        {entry.label === undefined ? null : <span className="fy-peer-clock">{entry.label}</span>}
      </header>
      <Markdown className="fy-peer-body" text={entry.text} {...surface} />
      {/* Where this send is, as the same small receipt mark the reader's own bubbles wear. */}
      <MessageFooter record={entry.send} />
      {peer.note === '' ? null : (
        <details className="fy-peer-note">
          <summary>Delivery note for the agent</summary>
          <p>{peer.note}</p>
        </details>
      )}
    </article>
  );
}

export function SystemNoticeRow({ entry, rhythm }: { readonly entry: TranscriptEntry; readonly rhythm: Rhythm }) {
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome"
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      <span className="fy-system-label">Ferretry</span>
      <Markdown className="fy-system-text" text={entry.text} />
      {entry.label === undefined ? null : <span className="fy-system-clock">{entry.label}</span>}
    </div>
  );
}
