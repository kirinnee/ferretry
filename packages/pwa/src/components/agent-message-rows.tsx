import { splitFerretryNotice } from '@ferretry/protocol';
import {
  Activity,
  ArrowRightLeft,
  BookOpen,
  ClipboardList,
  Cog,
  type LucideIcon,
  RotateCw,
  Send,
  ShieldCheck,
  SquareKanban,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useId, useState } from 'react';
import { linkNudgePullRequests } from '../lib/board-nudge.ts';
import { displayCallsign } from '../lib/callsign.ts';
import { useCardPullRequests } from '../lib/card-pull-requests.tsx';
import { ferretryLine } from '../lib/ferretry-sender.ts';
import { clockOfInstant } from '../lib/message-clock.ts';
import { ferretryChip, stripFraming } from '../lib/message-framing.ts';
import type { InstructionsUpdate } from '../lib/instructions-update.ts';
import { peerPreview } from '../lib/peer-preview.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import type { PeerFrom } from '../lib/peer-message.ts';
import type { ResolvedAgent } from '../lib/references.ts';
import type { TranscriptEntry } from '../lib/session-screens.ts';
import { Markdown } from './markdown.tsx';
import { type ReferenceSurface, useReferenceSurface } from './reference-surface.tsx';
import { MessageFooter } from './send-receipt.tsx';

/**
 * The two transcript rows that arrive on the user channel but are NOT the person speaking.
 *
 * A PEER MESSAGE reads as a message FROM that ferret, never as a "You" bubble: a card on the left with
 * the sender's monogram, the sender as a `:name` reference (docs/reference-standard.md) through the one
 * renderer so it proves and opens like any other, what kind of message it is, and the message itself as
 * Markdown. Nothing the daemon wrote for the RECEIVING agent is shown — not the banner, not the session
 * id, not the reply command — because the person reading is not who it was addressed to. Under it, a
 * quiet link opens the sender's own conversation, and only when the sender is proved.
 *
 * A FERRETRY NOTICE — a message this machine typed into the session itself, such as a send that did
 * not arrive — is a compact system line, never a "You" bubble the person would not recognise.
 */

type Rhythm = Record<string, string | undefined>;

/** What a peer message says about itself, beside the sender's name. A plain note says nothing. */
const KIND_LABEL: Readonly<Record<PeerFrom['kind'], string | undefined>> = {
  message: undefined,
  question: 'waiting for a reply',
  reply: 'replied',
};

/**
 * The sender, when this session can PROVE it: by its session id when the message names one — the
 * stable identity — and by its name otherwise. Unproved, it is a name and nothing to click.
 */
const provedPeer = (surface: ReferenceSurface, peer: Pick<PeerFrom, 'name' | 'sessionId'>): ResolvedAgent | null => {
  const resolve = surface.agentReferenceResolver;
  if (resolve === undefined) return null;
  const answer = peer.sessionId === undefined ? resolve({ name: peer.name }) : resolve({ sessionId: peer.sessionId });
  return answer ?? null;
};

/**
 * The sender's name: a proved `:name` reference that opens it, or the plain name. Read through the
 * shared renderer by the PROVED name, so the link names the same session the proof found.
 */
export function PeerName({
  peer,
  surface,
}: {
  readonly peer: Pick<PeerFrom, 'name' | 'sessionId'>;
  readonly surface: ReferenceSurface;
}) {
  const agent = provedPeer(surface, peer);
  if (agent === null) return <span className="fy-peer-name">{displayCallsign(peer.name)}</span>;
  return <Markdown className="fy-peer-reference" text={`:${agent.name}`} {...surface} />;
}

/** "Open conversation with tomi" — a real link, so a modifier-click still opens a new tab. */
function OpenConversation({ agent, surface }: { readonly agent: ResolvedAgent; readonly surface: ReferenceSurface }) {
  const navigate = surface.onNavigate;
  if (navigate === undefined) return null;
  const to = daemonSessionPath(agent.daemonId, agent.sessionId);
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a className="fy-peer-open" href={to} onClick={open}>
      Open conversation with {displayCallsign(agent.name)}
    </a>
  );
}

/**
 * A ferret's message at rest: the sender chip above and the first line (about 120 characters) here, with
 * "Show more" for the rest. A message that fits in its preview has nothing to open, so no control shows.
 * `text` is what the message says, for the preview; `children` is the whole of it, drawn once opened.
 */
function PeerBody({ text, children }: { readonly text: string | undefined; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { preview, truncated } = peerPreview(text ?? '');
  if (text === undefined || !truncated) return <>{children}</>;
  return (
    <>
      {open ? (
        <div id={id}>{children}</div>
      ) : (
        <p className="fy-peer-preview" data-peer-preview="" id={id}>
          {preview}
        </p>
      )}
      <button
        aria-controls={id}
        aria-expanded={open}
        className="fy-peer-more"
        data-peer-more=""
        onClick={() => setOpen(current => !current)}
        type="button"
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </>
  );
}

export function PeerMessageRow({
  entry,
  peer,
  rhythm,
  body,
  text,
}: {
  readonly entry: TranscriptEntry;
  readonly peer: PeerFrom;
  readonly rhythm: Rhythm;
  /** What the message holds, when it is not `entry.text` — a hand-off's document and its files. */
  readonly body?: ReactNode;
  /** The words of a hand-off's `body`, once read; absent while the document is still being read. */
  readonly text?: string;
}) {
  const surface = useReferenceSurface();
  const words = body === undefined ? stripFraming(entry.text).body : text;
  const name = displayCallsign(peer.name);
  const agent = provedPeer(surface, peer);
  const kind = KIND_LABEL[peer.kind];
  return (
    <article
      className="fy-message fy-message-peer"
      data-peer={peer.name}
      data-peer-kind={peer.kind}
      data-transcript-kind="user"
      {...rhythm}
    >
      <header>
        <span aria-hidden="true" className="fy-peer-avatar">
          {name.charAt(0)}
        </span>
        <span className="sr-only">Message from ferret</span>
        <PeerName peer={peer} surface={surface} />
        <span className="fy-peer-role">ferret</span>
        {kind === undefined ? null : (
          <span className="fy-peer-kind" data-peer-kind={peer.kind}>
            {kind}
          </span>
        )}
      </header>
      <PeerBody text={words}>
        {body ?? <Markdown className="fy-peer-body" text={stripFraming(entry.text).body} {...surface} />}
      </PeerBody>
      {/* Where this send is, as the same small receipt mark the reader's own bubbles wear. */}
      <MessageFooter clock={clockOfInstant(entry.at)} record={entry.send} side="other" />
      {agent === null ? null : <OpenConversation agent={agent} surface={surface} />}
    </article>
  );
}

export function SystemNoticeRow({ entry, rhythm }: { readonly entry: TranscriptEntry; readonly rhythm: Rhythm }) {
  const framed = stripFraming(entry.text);
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome"
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      <span className="fy-system-label" data-sender-chip>
        {ferretryChip(framed)}
      </span>
      <Markdown className="fy-system-text" text={framed.body} />
      <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
    </div>
  );
}

/**
 * "Ferretry changed part of your instructions": one gear line naming the sections, folded. Opening it
 * shows the changed sections whole — never the lead-in, which is addressed to the agent.
 */
export function InstructionsUpdateRow({
  entry,
  rhythm,
  update,
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Rhythm;
  readonly update: InstructionsUpdate;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome"
      data-instructions-update=""
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      <Cog aria-hidden="true" className="fy-system-icon" size={12} />
      <span className="fy-system-text">
        <span className="sr-only">Ferretry: </span>
        {update.headline}
        {update.sections.length === 0 ? null : (
          <>
            <span aria-hidden="true"> · </span>
            <button
              aria-controls={detailId}
              aria-expanded={open}
              className="fy-system-details"
              onClick={() => setOpen(current => !current)}
              type="button"
            >
              {open ? 'Hide' : 'Show'}
            </button>
          </>
        )}
      </span>
      <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
      {open ? (
        <div className="fy-system-detail" data-system-detail="" id={detailId}>
          {update.sections.map(section => (
            <p key={section.label}>{section.text}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A Ferretry notice that reached the agent THROUGH A FILE, such as the one a restart sends when it
 * interrupted work: a gear and its one-line headline, with what was written for the agent behind a
 * "details" control. It is never an owner bubble — the owner did not type it.
 */
export function HandoffNoticeRow({
  entry,
  notice,
  rhythm,
}: {
  readonly entry: TranscriptEntry;
  readonly notice: string;
  readonly rhythm: Rhythm;
}) {
  const [open, setOpen] = useState(false);
  const { headline, details } = splitFerretryNotice(notice);
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome"
      data-system-notice=""
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      <Cog aria-hidden="true" className="fy-system-icon" size={12} />
      <span className="fy-system-text">
        <span className="sr-only">Ferretry: </span>
        {headline}
        {details === null ? null : (
          <>
            <span aria-hidden="true"> · </span>
            <button
              aria-expanded={open}
              className="fy-system-details"
              onClick={() => setOpen(current => !current)}
              type="button"
            >
              details
            </button>
          </>
        )}
      </span>
      <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
      {open && details !== null ? (
        <p className="fy-system-detail" data-system-detail="">
          {details}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The board's own automatic message to a ferret — "&F209 PR #1087 CI is red. Fix it…" — as one compact
 * system line: a board mark, "Board" as the sender, the sentence, and the card and PR it names as links.
 * It is never an owner bubble: the owner did not type it.
 */
export function BoardNudgeRow({
  entry,
  rhythm,
  text,
}: {
  readonly entry: TranscriptEntry;
  readonly rhythm: Rhythm;
  readonly text: string;
}) {
  const cards = useCardPullRequests();
  const surface = useReferenceSurface();
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome"
      data-board-nudge=""
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      <SquareKanban aria-hidden="true" className="fy-system-icon" size={12} />
      <span className="fy-system-label" data-sender-chip>
        Board
      </span>
      <Markdown className="fy-system-text" text={linkNudgePullRequests(stripFraming(text).body, cards)} {...surface} />
      <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
    </div>
  );
}

const FEATURE_ICONS: Readonly<Record<string, LucideIcon>> = {
  Warden: ShieldCheck,
  Agenda: ClipboardList,
  Monitor: Activity,
  Lessons: BookOpen,
  Migrate: ArrowRightLeft,
  Restart: RotateCw,
  Delivery: Send,
};

/**
 * Any message Ferretry itself typed into a ferret's chat — a Warden nudge, an agenda reminder, a delivery
 * notice — as one compact system line: the part of Ferretry's icon, its name, one line of what it said, and
 * the rest behind "Show". Who sent it is the sender metadata, never a tag in the words; never an owner bubble.
 */
export function FerretryMessageRow({
  entry,
  feature,
  rhythm,
  text,
}: {
  readonly entry: TranscriptEntry;
  readonly feature: string;
  readonly rhythm: Rhythm;
  readonly text: string;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const Icon = FEATURE_ICONS[feature] ?? Cog;
  const { line, long } = ferretryLine(stripFraming(text).body);
  return (
    <div
      className="fy-message fy-message-system fy-message-chrome"
      data-ferretry-message={feature}
      data-transcript-kind="system"
      role="note"
      {...rhythm}
    >
      <Icon aria-hidden="true" className="fy-system-icon" size={12} />
      <span className="fy-system-text">
        <span className="fy-system-label" data-sender-chip>
          Ferretry · {feature}
        </span>
        <span aria-hidden="true"> · </span>
        {line}
        {long ? (
          <>
            <span aria-hidden="true"> · </span>
            <button
              aria-controls={detailId}
              aria-expanded={open}
              className="fy-system-details"
              onClick={() => setOpen(current => !current)}
              type="button"
            >
              {open ? 'Hide' : 'Show'}
            </button>
          </>
        ) : null}
      </span>
      <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
      {open ? (
        <div className="fy-system-detail" data-system-detail="" id={detailId}>
          <p>{stripFraming(text).body}</p>
        </div>
      ) : null}
    </div>
  );
}
