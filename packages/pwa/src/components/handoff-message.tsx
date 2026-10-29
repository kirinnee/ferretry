/**
 * The reader's own message when it reached the agent THROUGH A FILE.
 *
 * A long, multi-line or attached message is written to a turn document and the agent is typed one line
 * that points at it, so the transcript records "Read the file …/turn-008.md now, then carefully follow
 * every instruction inside it" where the person's words belong. Shown verbatim that reads exactly like
 * an injected instruction. This row shows what the person actually sent instead — the document's text as
 * Markdown and its attachments as thumbnails and chips — read through the daemon's hand-off route, and
 * says in one line, behind a small "via turn file" control, why it travelled that way.
 *
 * WHEN THE FILE CANNOT BE READ, the pointer is shown faded with that same explanation always visible: the
 * reader is told what the line is rather than shown a bare instruction, and nothing is invented.
 *
 * The source comes from context for the reason the reference surface does (`reference-surface.tsx`): a
 * transcript row sits under a virtualised list, and the session page is where the daemon connection and
 * the session live. Outside a session there is no source, and the row degrades to the faded pointer.
 */

import type { DeliveredAttachment, HandoffPointer, SessionHandoff } from '@ferretry/protocol';
import { FileText, Info } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { StoredTranscriptAttachment } from '../lib/attachments.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { TranscriptAttachmentGallery } from './attachment-gallery.tsx';
import { Markdown } from './markdown.tsx';

/** The one line that says why a message travelled as a file. */
export const TURN_FILE_EXPLANATION =
  "Long or attached messages are handed to the agent as a file so the terminal can't mangle them.";

/** Where a session's hand-off documents are read from. */
export interface HandoffSource {
  readonly daemon: DaemonConnection;
  readonly sessionId: string;
  readonly read: (name: string) => Promise<SessionHandoff>;
}

interface HandoffReader {
  readonly source: HandoffSource;
  /** Every document this session has read, by name. A document is written once, so a read is kept. */
  readonly read: (name: string) => Promise<SessionHandoff>;
  /** The daemon and session the cache belongs to. */
  readonly scope: string;
}

const HandoffContext = createContext<HandoffReader | null>(null);

export function HandoffSourceProvider({
  source,
  children,
}: {
  readonly source: HandoffSource;
  readonly children: ReactNode;
}) {
  // One cache per daemon and session: a row scrolled away and back, or re-rendered by a poll, asks once.
  // A failed read is forgotten, so a daemon that answers later is asked again. Keyed on the daemon and
  // the session rather than on the object, because a page re-render builds a new source for the same one.
  const latest = useRef(source);
  latest.current = source;
  const daemonId = source.daemon.daemonId;
  const sessionId = source.sessionId;
  const reader = useMemo((): HandoffReader => {
    const cache = new Map<string, Promise<SessionHandoff>>();
    return {
      get source() {
        return latest.current;
      },
      read: name => {
        const held = cache.get(name);
        if (held !== undefined) return held;
        const reading = latest.current.read(name);
        cache.set(name, reading);
        reading.catch(() => cache.delete(name));
        return reading;
      },
      scope: `${daemonId}\u0000${sessionId}`,
    };
  }, [daemonId, sessionId]);
  return <HandoffContext.Provider value={reader}>{children}</HandoffContext.Provider>;
}

/** The daemon and session this part of the page reads from, or null outside a session workspace. */
export function useHandoffSource(): HandoffSource | null {
  return useContext(HandoffContext)?.source ?? null;
}

export type HandoffReading =
  | { readonly state: 'reading' }
  | { readonly state: 'read'; readonly handoff: SessionHandoff }
  | { readonly state: 'gone' };

const GONE: HandoffReading = { state: 'gone' };
const READING: HandoffReading = { state: 'reading' };

/**
 * The reading of ONE named document, held against the reader and the name it was read for. A row that
 * starts reading a document later — the reader's own message the moment it lands as a hand-off — is
 * therefore `reading` from its first render, never a frame of a previous answer or of `gone`.
 * No name reads nothing.
 */
function useHandoff(reader: HandoffReader | null, name: string | undefined): HandoffReading {
  const [held, setHeld] = useState<{
    readonly reader: HandoffReader;
    readonly name: string;
    readonly reading: HandoffReading;
  } | null>(null);
  useEffect(() => {
    if (reader === null || name === undefined) return;
    let live = true;
    reader.read(name).then(
      handoff => live && setHeld({ reader, name, reading: { state: 'read', handoff } }),
      () => live && setHeld({ reader, name, reading: GONE }),
    );
    return () => {
      live = false;
    };
  }, [reader, name]);
  if (reader === null) return GONE;
  return held !== null && held.reader === reader && held.name === name ? held.reading : READING;
}

/**
 * One hand-off document, read once for the row that shows it. The row decides whose message it is from
 * what the document holds — a ferret's message carries its banner — so the read is lifted out of the
 * renderer and handed to whichever row that turns out to be.
 */
export function useHandoffReading(name: string | undefined): {
  readonly reading: HandoffReading;
  readonly source: HandoffSource | null;
} {
  const reader = useContext(HandoffContext);
  const reading = useHandoff(reader, name);
  return { reading, source: reader === null ? null : reader.source };
}

/**
 * What the reader's own send put in its document, known before the document is read: the send IS the
 * document's message. Drawn while the document is being read so a message handed over through a file
 * reads the same from the moment it is sent, instead of flashing an "Opening…" line as it lands.
 */
export interface HandoffDraft {
  readonly message: string;
  readonly files: readonly DeliveredAttachment[];
}

/** A hand-off as its reading stands: the message, an "Opening…" line, or the faded pointer. */
export function HandoffView({
  pointer,
  pointerText,
  reading,
  source,
  draft,
}: {
  /** Absent for a send not handed over yet: there is no pointer, only the message on its way. */
  readonly pointer?: HandoffPointer | undefined;
  /** The line the agent was typed, shown faded only when the document cannot be read. */
  readonly pointerText: string;
  readonly reading: HandoffReading;
  readonly source: HandoffSource | null;
  /** The message as its send knows it, drawn until the document has been read. */
  readonly draft?: HandoffDraft | undefined;
}) {
  return (
    <div className="fy-handoff" data-handoff={pointer?.name} data-handoff-state={reading.state}>
      {reading.state === 'read' && source !== null ? (
        <HandoffBody handoff={reading.handoff} source={source} />
      ) : reading.state === 'reading' && draft !== undefined ? (
        <HandoffDraftBody draft={draft} />
      ) : reading.state === 'reading' ? (
        <p aria-busy="true" className="fy-handoff-pending">
          Opening the message…
        </p>
      ) : (
        <p className="fy-handoff-pointer">{pointerText}</p>
      )}
      {reading.state === 'gone' ? <HandoffGoneNote /> : null}
    </div>
  );
}

export function HandoffBody({ handoff, source }: { readonly handoff: SessionHandoff; readonly source: HandoffSource }) {
  const stored = useMemo(
    () =>
      handoff.attachments.flatMap((attachment): StoredTranscriptAttachment[] =>
        attachment.attachmentId === undefined
          ? []
          : [
              {
                kind: 'attachment',
                sessionId: source.sessionId,
                attachmentId: attachment.attachmentId,
                filename: attachment.filename,
                mime: attachment.mime,
              },
            ],
      ),
    [handoff.attachments, source.sessionId],
  );
  // A listed file that is not one of this session's stored attachments cannot be fetched, so it keeps
  // its name as a plain chip rather than becoming a thumbnail that would ask for somebody else's file.
  const named = handoff.attachments.filter(attachment => attachment.attachmentId === undefined);
  return (
    <>
      {handoff.message.trim() === '' ? null : <Markdown className="fy-handoff-text" text={handoff.message} />}
      {stored.length === 0 ? null : (
        <TranscriptAttachmentGallery className="fy-handoff-files" daemon={source.daemon} images={stored} />
      )}
      {named.length === 0 ? null : (
        <ul className="fy-handoff-chips">
          {named.map(file => (
            <li className="fy-handoff-chip" key={`${file.filename}\u0000${file.mime}`} title={file.mime}>
              <FileText aria-hidden="true" size={14} />
              <span>{file.filename}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The send's own copy of the message, drawn exactly as `HandoffBody` draws the document: the same
 * Markdown, and each file it names as a chip. A file the daemon can serve becomes a thumbnail once the
 * document is read; until then its name is all this browser knows.
 */
function HandoffDraftBody({ draft }: { readonly draft: HandoffDraft }) {
  return (
    <>
      {draft.message.trim() === '' ? null : <Markdown className="fy-handoff-text" text={draft.message} />}
      {draft.files.length === 0 ? null : (
        <ul className="fy-handoff-chips">
          {draft.files.map(file => {
            const filename = file.path.split(/[\\/]/u).at(-1) || file.path;
            return (
              <li className="fy-handoff-chip" key={`${file.path}\u0000${file.mime}`} title={file.mime}>
                <FileText aria-hidden="true" size={14} />
                <span>{filename}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** When the file is gone the line is simply shown, because then it is the only thing explaining the faded pointer above it. */
function HandoffGoneNote() {
  return (
    <p className="fy-handoff-note" data-handoff-note="gone">
      <Info aria-hidden="true" size={12} />
      <span>The file this message was handed over in can no longer be read. {TURN_FILE_EXPLANATION}</span>
    </p>
  );
}

/**
 * "via turn file": a hover tooltip on a desktop, a tap that reads the line out on a phone (which has no
 * hover) — the same contract the message foot's time follows. It is NOT drawn by the hand-off itself: the
 * bubble hands it to its foot (`MessageFooter`'s `lead`) so it shares the line the time and ticks are on.
 */
export function HandoffVia({ open, onToggle }: { readonly open: boolean; readonly onToggle: () => void }) {
  return (
    <button
      aria-expanded={open}
      aria-label={`Sent via turn file. ${TURN_FILE_EXPLANATION}`}
      className="fy-handoff-via-button"
      onClick={onToggle}
      title={TURN_FILE_EXPLANATION}
      type="button"
    >
      <Info aria-hidden="true" size={12} />
      <span aria-hidden="true">via turn file</span>
    </button>
  );
}

/** What "via turn file" says when it is opened, drawn under the foot. */
export function HandoffViaDetail() {
  return (
    <p className="fy-receipt-detail" data-handoff-note="explained" data-side="own">
      {TURN_FILE_EXPLANATION}
    </p>
  );
}
