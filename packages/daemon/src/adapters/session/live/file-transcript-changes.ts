import type { ClockPort } from '../../../lib/ports.ts';
import type { TranscriptChangeSource, TranscriptChangeWatch } from '../../../lib/session/events/service.ts';

/** The piece of the file-event hub this listens through (`FileEventHub` is one). */
export interface TranscriptFileEvents {
  subscribe(path: string, listener: (path: string) => void): { close(): void };
}

/** What a file's bytes look like from outside: enough to tell "it was written" from "it was looked at". */
export interface TranscriptFileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface FileTranscriptChangesPorts {
  /** The transcript file the session has proved as its own, or `undefined` while it has none. */
  readonly file: (sessionId: string) => Promise<string | undefined>;
  /** The file's stamp, or `undefined` when it cannot be read (not written yet, gone). */
  readonly stat: (file: string) => Promise<TranscriptFileStamp | undefined>;
  readonly files: TranscriptFileEvents;
  readonly clock: ClockPort;
}

const sameStamp = (a: TranscriptFileStamp | undefined, b: TranscriptFileStamp | undefined): boolean =>
  a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;

/**
 * A session's transcript changes, heard through the daemon's file-event hub (`?transcript=1`).
 *
 * THE FILE is the one the transcript resolver proves — the same one every transcript read serves — so a
 * change heard here is one the reader's next read will see. It is resolved when the watch starts and
 * again whenever the stream's journal moves: a new session has no transcript until its first message, and
 * a `/clear` or a resume moves it to another file. Moving to another file is itself a change.
 *
 * ONLY A WRITE IS A CHANGE. The hub reports a path it starts watching once, unconditionally — but only to
 * the first subscriber, so that report cannot simply be skipped — and every stream that opened would
 * otherwise cost its reader one read for nothing. So each notice is checked against the file's stamp,
 * taken BEFORE subscribing: a write between the two is then a stamp that moved, never a write missed.
 *
 * One resolution at a time per watch; one asked for while one runs runs once more after it.
 */
export class FileTranscriptChanges implements TranscriptChangeSource {
  constructor(private readonly ports: FileTranscriptChangesPorts) {}

  watch(sessionId: string, onChange: (at: string) => void): TranscriptChangeWatch {
    let closed = false;
    let followed: { readonly file: string; readonly close: () => void } | undefined;
    let resolved = false;
    let resolving = false;
    let again = false;

    const heard = (): void => {
      if (!closed) onChange(this.ports.clock.now());
    };

    const subscribe = async (file: string): Promise<{ readonly file: string; readonly close: () => void }> => {
      let stamp = await this.ports.stat(file).catch(() => undefined);
      const subscription = this.ports.files.subscribe(file, () => {
        void this.ports
          .stat(file)
          .catch(() => undefined)
          .then(now => {
            if (closed || followed?.file !== file || sameStamp(now, stamp)) return;
            stamp = now;
            heard();
          });
      });
      return { file, close: () => subscription.close() };
    };

    const follow = async (): Promise<void> => {
      const file = await this.ports.file(sessionId).catch(() => undefined);
      if (closed || file === followed?.file) {
        resolved = true;
        return;
      }
      followed?.close();
      followed = undefined;
      if (file !== undefined) {
        const next = await subscribe(file);
        if (closed) {
          next.close();
          return;
        }
        followed = next;
      }
      // The first resolution only starts listening; a later one that found another file is a change.
      if (resolved) heard();
      resolved = true;
    };

    const resolve = async (): Promise<void> => {
      if (resolving) {
        again = true;
        return;
      }
      resolving = true;
      try {
        do {
          again = false;
          await follow();
        } while (again && !closed);
      } finally {
        resolving = false;
      }
    };

    void resolve();
    return {
      refresh: () => {
        if (!closed) void resolve();
      },
      close: () => {
        closed = true;
        followed?.close();
        followed = undefined;
      },
    };
  }
}
