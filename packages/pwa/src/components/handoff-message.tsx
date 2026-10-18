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

import type { HandoffPointer, SessionHandoff } from '@ferretry/protocol';
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

type Reading =
  | { readonly state: 'reading' }
  | { readonly state: 'read'; readonly handoff: SessionHandoff }
  | { readonly state: 'gone' };

function useHandoff(reader: HandoffReader | null, name: string): Reading {
  const [reading, setReading] = useState<Reading>(reader === null ? { state: 'gone' } : { state: 'reading' });
  useEffect(() => {
    if (reader === null) return;
    let live = true;
    setReading({ state: 'reading' });
    reader.read(name).then(
      handoff => live && setReading({ state: 'read', handoff }),
      () => live && setReading({ state: 'gone' }),
    );
    return () => {
      live = false;
    };
  }, [reader, name]);
  return reading;
}

export function HandoffMessage({
  pointer,
  pointerText,
}: {
  readonly pointer: HandoffPointer;
  /** The line the agent was typed, shown faded only when the document cannot be read. */
  readonly pointerText: string;
}) {
  const reader = useContext(HandoffContext);
  const reading = useHandoff(reader, pointer.name);
  return (
    <div className="fy-handoff" data-handoff={pointer.name} data-handoff-state={reading.state}>
      {reading.state === 'read' ? (
        <HandoffBody handoff={reading.handoff} source={(reader as HandoffReader).source} />
      ) : reading.state === 'reading' ? (
        <p aria-busy="true" className="fy-handoff-pending">
          Opening the message…
        </p>
      ) : (
        <p className="fy-handoff-pointer">{pointerText}</p>
      )}
      <HandoffNote gone={reading.state === 'gone'} />
    </div>
  );
}

function HandoffBody({ handoff, source }: { readonly handoff: SessionHandoff; readonly source: HandoffSource }) {
  const stored = handoff.attachments.flatMap((attachment): StoredTranscriptAttachment[] =>
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
 * "via turn file": a hover tooltip on a desktop, a tap that reads the line out on a phone (which has no
 * hover) — the same contract the message foot's time follows. When the file is gone the line is simply
 * shown, because then it is the only thing explaining the faded pointer above it.
 */
function HandoffNote({ gone }: { readonly gone: boolean }) {
  const [open, setOpen] = useState(false);
  if (gone)
    return (
      <p className="fy-handoff-note" data-handoff-note="gone">
        <Info aria-hidden="true" size={12} />
        <span>The file this message was handed over in can no longer be read. {TURN_FILE_EXPLANATION}</span>
      </p>
    );
  return (
    <>
      <div className="fy-handoff-via">
        <button
          aria-expanded={open}
          aria-label={`Sent via turn file. ${TURN_FILE_EXPLANATION}`}
          className="fy-handoff-via-button"
          onClick={() => setOpen(current => !current)}
          title={TURN_FILE_EXPLANATION}
          type="button"
        >
          <Info aria-hidden="true" size={12} />
          <span aria-hidden="true">via turn file</span>
        </button>
      </div>
      {open ? (
        <p className="fy-handoff-note" data-handoff-note="explained">
          {TURN_FILE_EXPLANATION}
        </p>
      ) : null}
    </>
  );
}
