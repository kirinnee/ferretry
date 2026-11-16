/**
 * THE THREE SMALL PARTS THE PACK CARD IS DRAWN WITH, as far as the card reads them: the helper's name as a proved `:name`
 * reference, the time under the card, and the command a call ran. They are the card's own, because the chat's PeerName,
 * MessageFooter and ToolGroup are Conversation's app files, which another plugin's half may not import. The card is drawn
 * beside the row that holds the calls, so Conversation's tool group already shows each call whole; "Show command" here
 * names the command and what it printed, in text.
 */
import { Markdown, type ReferenceSurface } from '@ferretry/app';
import { type ReactNode, useState } from 'react';
import type { MessageClock, ToolCall } from '../lib/shell-ports.ts';

/** `nadia` → `Nadia`, `warden-00002a` → `warden-00002A`: a callsign the way a reader sees it. */
const SYSTEM_CALLSIGN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;
const displayName = (raw: string): string => {
  const slug = raw.trim();
  const system = SYSTEM_CALLSIGN.exec(slug);
  if (system?.[1] !== undefined && system[2] !== undefined)
    return `${system[1].toLowerCase()}-${system[2].toUpperCase()}`;
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};

/**
 * The helper's name: a proved `:name` reference that opens it, or the plain name. Proof is the reference surface's
 * agent resolver, by the helper's stable id, so the link names the same ferret the proof found.
 */
export function PeerName({
  peer,
  surface,
}: {
  readonly peer: { readonly name: string; readonly ferretId: string };
  readonly surface: ReferenceSurface;
}): ReactNode {
  const agent = surface.agentReferenceResolver?.({ sessionId: peer.ferretId }) ?? null;
  if (agent === null) return <span className="fy-peer-name">{displayName(peer.name)}</span>;
  return <Markdown className="fy-peer-reference" text={`:${agent.name}`} {...surface} />;
}

/** The time under a card: the short clock, and the full instant when it is pressed. */
export function MessageFooter({
  clock,
  side = 'own',
}: {
  readonly clock: MessageClock | undefined;
  readonly side?: 'own' | 'other';
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (clock === undefined) return null;
  return (
    <>
      <div className="fy-receipt-line" data-message-footer="" data-side={side}>
        <button
          aria-expanded={open}
          aria-label={`Sent ${clock.full}`}
          className="fy-receipt"
          onClick={() => setOpen(current => !current)}
          title={clock.full}
          type="button"
        >
          <time aria-hidden="true">{clock.short}</time>
        </button>
      </div>
      {open ? (
        <p className="fy-receipt-detail" data-side={side} data-time-full="">
          {clock.full}
        </p>
      ) : null}
    </>
  );
}

/** The commands a card stands for and what each printed, as text. */
export function ToolGroup({
  calls,
}: {
  readonly calls: readonly ToolCall[];
  /** Said by the transcript's own group (still running, last of the run); this one is the same for both. */
  readonly live?: boolean;
  readonly isLast?: boolean;
}): ReactNode {
  return (
    <div className="fy-pack-commands" data-pack-commands="">
      {calls.map(call => {
        const input = call.use.input as { readonly command?: unknown } | undefined;
        const command = typeof input?.command === 'string' ? input.command : '';
        return (
          <div className="fy-pack-command" key={call.key}>
            <p className="fy-pack-mono">
              <span className="fy-pack-muted">{call.use.name ?? 'Bash'} · </span>
              {command}
            </p>
            {call.result?.text === undefined || call.result.text === '' ? null : (
              <pre className="fy-pack-output" data-error={call.result.isError === true ? '' : undefined}>
                {call.result.text}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
