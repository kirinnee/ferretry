import { type Clock, type FencedPath, MAX_ROOT_WINDOW_BYTES, type RootHandle } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { type HarnessTranscriptBytes, HarnessTranscriptReplaced } from './kinds.ts';

/** The part of a root the byte handle needs: a harness hands over its own proved `agent-homes` root. */
export type TranscriptBytesRoot = Pick<RootHandle, 'openBytes'>;

/** The length of the opaque token (22 hex characters of a SHA-256, as v4's transcript location token). */
const TOKEN_LENGTH = 22;

/**
 * How long an UNUSED handle keeps its descriptor. Every call renews it; the single consumer closes the handle when it is
 * done, and this is the backstop for one that never does (a descriptor is a scarce thing, and nothing finalises one).
 */
export const TRANSCRIPT_HANDLE_IDLE_MS = 60_000;

export interface TranscriptBytesOptions {
  /** The kernel clock that times the idle backstop (a contract reads no timer of its own). Without one there is no backstop. */
  readonly clock?: Pick<Clock, 'after'>;
  /** Idle time after which the handle closes itself (default {@link TRANSCRIPT_HANDLE_IDLE_MS}). */
  readonly idleMs?: number;
}

/**
 * Opens a {@link HarnessTranscriptBytes} over the ONE file a harness proved to be a ferret's transcript (G162). Shared by
 * the harnesses so the rules cannot drift between them. The handle is bound to ONE OPENED OBJECT, not to a pathname:
 *
 * - the kernel root opens the file once (the leaf never followed: a link at the name, even to a file inside the root, is
 *   refused) and the handle holds that descriptor. `read` is a `pread` and `stat` an `fstat` of it, so the bytes and the
 *   metadata are the held object's and no other's, whatever the name reaches meanwhile; the descriptor pins the inode, so
 *   its number cannot be freed and handed to another file under a handle that is still open;
 * - before and after every read and stat the NAME is looked at (never followed) and must still reach that object as a
 *   regular file, else the call rejects {@link HarnessTranscriptReplaced} (a read) or answers `undefined` (a stat);
 * - the handle names no path: `file` is a digest of the path, the device, the inode and, where the host reports one, the
 *   creation time (so a file removed and recreated under a reused inode number is another generation with another
 *   token), and no field of the handle and no message of an error it raises carries the path;
 * - a host that reports NO creation time cannot tell a generation from the one before it once the old descriptor is gone
 *   (the inode number can be handed out again), so then the token also carries a nonce drawn for THIS open: it never
 *   repeats for another open, and it is the same for every use of this handle. The consequence, said plainly: on such a
 *   host two handles on one unchanged file have different tokens, and a consumer that compares tokens across handles
 *   sees a change and starts over (it never mistakes a replacement for the same file);
 * - a window is `[offset, offset + length)` clamped to `MAX_ROOT_WINDOW_BYTES`, short where the file ends and empty past
 *   it; a negative, fractional or unsafe offset or length is refused;
 * - `close()` lets the descriptor go (idempotent); an unused handle closes itself after `idleMs`.
 *
 * `undefined` when the root offers no held open or the name is not a regular file the root can open. Once the descriptor
 * is held, ANY failure (the first stat, the digest, the clock that times the backstop) closes it before the failure
 * leaves: a handle is returned only if it owns its descriptor and a backstop for it, and none that cannot.
 */
export async function openTranscriptBytes(
  root: TranscriptBytesRoot,
  file: FencedPath,
  format: HarnessTranscriptBytes['format'],
  /** SHA-256 of the text as lowercase hex (a contract imports no `node:crypto`, so the harness supplies it). */
  sha256Hex: (text: string) => string,
  options: TranscriptBytesOptions = {},
): Promise<HarnessTranscriptBytes | undefined> {
  // A refusal (a link at the name, a fence, a hard link) is no proved transcript: none is offered, and the root's refusal
  // (whose text can name the place) is not passed on.
  const opened = await root.openBytes?.(file).catch(() => undefined);
  if (opened === undefined) return undefined;
  const idleMs = options.idleMs ?? TRANSCRIPT_HANDLE_IDLE_MS;
  let closed = false;
  let cancel: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    // Idempotent, and a second caller waits for the first one's descriptor to be gone.
    closing ??= (async () => {
      closed = true;
      cancel?.();
      await opened.close().catch(() => undefined);
    })();
    await closing;
  };
  const touch = (): void => {
    if (closed) return;
    cancel?.();
    cancel = options.clock?.after(milliseconds(idleMs), () => void close());
  };
  let first: { readonly size: number; readonly mtimeMs: number };
  try {
    first = await opened.stat();
    if (!(await opened.stillNames())) {
      await close();
      return undefined;
    }
  } catch {
    await close();
    return undefined;
  }
  let token: string;
  try {
    // Where the host reports no creation time the object alone cannot name a generation: this open's own nonce does.
    const generation = opened.birthNs === undefined ? `\0open:${crypto.randomUUID()}` : `\0${opened.birthNs}`;
    token = sha256Hex(`${file}\0${opened.identity.device}:${opened.identity.inode}${generation}`).slice(
      0,
      TOKEN_LENGTH,
    );
    // The first timer too: nothing past the acquisition may leave the descriptor without an owner.
    touch();
  } catch (failure) {
    // The digest or the clock is a caller's own port misbehaving: that is not hidden, but it never costs a descriptor.
    await close();
    throw failure;
  }
  const named = async (): Promise<boolean> => await opened.stillNames().catch(() => false);
  return {
    format,
    file: token,
    size: first.size,
    mtimeMs: first.mtimeMs,
    read: async (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('the transcript offset is out of range');
      if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('the transcript length is out of range');
      if (closed) throw new Error('the transcript handle is closed');
      touch();
      if (!(await named())) throw new HarnessTranscriptReplaced();
      if (length === 0) return new Uint8Array(0);
      let bytes: Uint8Array;
      try {
        bytes = await opened.read(offset, Math.min(length, MAX_ROOT_WINDOW_BYTES));
      } catch {
        // The root's own message may name the path: say only what happened.
        if (!(await named())) throw new HarnessTranscriptReplaced();
        throw new Error('the transcript could not be read');
      }
      if (!(await named())) throw new HarnessTranscriptReplaced();
      return bytes;
    },
    stat: async () => {
      if (closed) return undefined;
      touch();
      if (!(await named())) return undefined;
      const now = await opened.stat().catch(() => undefined);
      // The size and time came off the descriptor; the name must STILL reach it, or they describe a replaced file.
      return now !== undefined && (await named()) ? { size: now.size, mtimeMs: now.mtimeMs } : undefined;
    },
    close,
  };
}
