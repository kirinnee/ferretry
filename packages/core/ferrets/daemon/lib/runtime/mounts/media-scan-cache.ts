import type { ReadTarget } from '../../session/filesystem/index.ts';

/**
 * WHAT THE WHOLE-FILE SECRET SCAN FOUND, KEPT SO A FILE IS SCANNED ONCE AND NOT ONCE PER PIECE.
 *
 * `fs/media` serves a clip in 4 MiB ranges and refuses any file that holds a vault value. Scanning means reading every
 * byte, and doing it per range read and scanned a 32 MiB clip eight times (measured: 0.3-0.5 s of blocked event loop and
 * +200-300 MiB per request). A verdict is a fact about ONE set of bytes under ONE set of vault values, so it is kept under
 * both and under nothing looser:
 *
 *  - THE FILE: device, inode, size, mtime and ctime of the descriptor the bytes come from (`ReadTarget`). A rewrite in
 *    place moves ctime and mtime; a replacement moves the inode; either is a different key, so it is scanned again.
 *    (Declared residue: a rewrite inside one clock tick of the scan's own `fstat` leaves the same ctime.)
 *  - THE VAULT: a keyed digest of every value the read would mask (`RedactionScope.fingerprint`). Any value stored,
 *    rotated, removed, typed or expired changes it, so EVERY verdict made under the old set stops matching. A verdict is
 *    never trusted on the key alone, and a redactor that cannot give a digest keeps nothing.
 *
 * ONE SCAN PER FILE AT A TIME. The first request to reach a file with no verdict owes the scan; the others wait for it
 * rather than reading the same 32 MiB again beside it. A range is served only from a verdict that EXISTS: nothing is
 * served from a file whose scan is unfinished, refused, or failed (a failed one is retried by a waiter, never assumed
 * clean).
 *
 * BOUNDED. At most `capacity` verdicts (least recently used goes first), plus the scans in flight, which are as many
 * as there are distinct files being asked for at this moment. Nothing here holds a value or a byte.
 */

/** What one scan found, and the vault it found it under. */
export interface MediaVerdict {
  /** Whether the file holds a vault value: a refused file is refused every time, without reading it. */
  readonly secret: boolean;
  /** The digest of the vault the file was judged against. */
  readonly fingerprint: string;
}

/** What {@link MediaScanCache.claim} tells a request to do. */
export type MediaScanClaim =
  /** Decided already, under this vault: serve (or refuse) without reading the whole file. */
  | { readonly kind: 'verdict'; readonly secret: boolean }
  /** Another request is scanning this file now: wait for it, then claim again. */
  | { readonly kind: 'wait'; readonly until: Promise<MediaVerdict | undefined> }
  /** This request owes the scan. It MUST call `settle` exactly once: with the verdict, or with nothing if it failed. */
  | { readonly kind: 'scan'; readonly settle: (verdict: MediaVerdict | undefined) => void };

/** The number of verdicts kept. A file is 32 MiB at most, so this is a bound on bookkeeping, not on memory. */
const MEDIA_SCAN_CAPACITY = 64;

export class MediaScanCache {
  private readonly verdicts = new Map<string, MediaVerdict>();
  private readonly scanning = new Map<string, Promise<MediaVerdict | undefined>>();

  constructor(private readonly capacity: number = MEDIA_SCAN_CAPACITY) {}

  /** The file a verdict is about, as one string. Every part of it comes from the open descriptor. */
  static keyOf(file: ReadTarget): string {
    const { dev, ino, ctimeNs } = file.identity;
    return `${dev}:${ino}:${file.size}:${file.mtime}:${ctimeNs}`;
  }

  /** How many verdicts are kept, for a test that proves the bound. */
  get kept(): number {
    return this.verdicts.size;
  }

  claim(key: string, fingerprint: string): MediaScanClaim {
    const kept = this.verdicts.get(key);
    if (kept !== undefined && kept.fingerprint === fingerprint) {
      // Most recently used goes last, so the first key is always the one to drop.
      this.verdicts.delete(key);
      this.verdicts.set(key, kept);
      return { kind: 'verdict', secret: kept.secret };
    }
    // A verdict under another vault says nothing about this one.
    if (kept !== undefined) this.verdicts.delete(key);
    const running = this.scanning.get(key);
    if (running !== undefined) return { kind: 'wait', until: running };
    let resolveScan: (verdict: MediaVerdict | undefined) => void = () => undefined;
    const done = new Promise<MediaVerdict | undefined>(resolve => {
      resolveScan = resolve;
    });
    this.scanning.set(key, done);
    return {
      kind: 'scan',
      settle: verdict => {
        // Idempotent: a second call finds nothing of its own to remove and resolves nothing new.
        if (this.scanning.get(key) !== done) return;
        this.scanning.delete(key);
        if (verdict !== undefined) this.keep(key, verdict);
        resolveScan(verdict);
      },
    };
  }

  private keep(key: string, verdict: MediaVerdict): void {
    this.verdicts.delete(key);
    this.verdicts.set(key, verdict);
    for (const oldest of this.verdicts.keys()) {
      if (this.verdicts.size <= this.capacity) break;
      this.verdicts.delete(oldest);
    }
  }
}
