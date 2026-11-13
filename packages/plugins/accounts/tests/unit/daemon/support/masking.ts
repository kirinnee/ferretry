/**
 * The Vault's masking registry as a secure copy's tests read it: the copy-hold parts of today's
 * `packages/daemon/src/lib/input-requests/ephemeral-values.ts` (bb89d054d), byte for byte. The Vault owns the real one;
 * TODO(contract): a Vault `contract/testing` fake of `CopyMasking`.
 */
import { COPY_AFTER_MASK_SECONDS, COPY_MAX_LIFETIME_SECONDS } from '../../../../contract/routes/index.ts';
import type { CopyMasking } from '../../../../daemon/lib/secure-copy/ports.ts';

const MIN_MASKED_LENGTH = 1;
const MAX_COPY_MASK_MS = (COPY_MAX_LIFETIME_SECONDS + COPY_AFTER_MASK_SECONDS) * 1000;

interface Held {
  readonly value: string;
  readonly label: string;
  readonly until: number;
  readonly marker?: string;
  readonly scrollback?: true;
}

export class EphemeralValues implements CopyMasking {
  private readonly held = new Map<string, readonly Held[]>();

  constructor(private readonly clock: { now(): number }) {}

  holdUntil(sessionId: string, value: string, marker: string, until: number): void {
    if (value.length < MIN_MASKED_LENGTH) return;
    this.purge();
    const latest = this.clock.now() + MAX_COPY_MASK_MS;
    this.held.set(sessionId, [
      ...(this.held.get(sessionId) ?? []),
      { value, label: marker, marker, until: Math.min(until, latest) },
    ]);
  }

  /** A value pasted into a terminal: masked for the life of the session's scrollback; `retime` does not shorten it. */
  holdScrollback(sessionId: string, value: string, marker: string): void {
    if (value.length < MIN_MASKED_LENGTH) return;
    this.purge();
    this.held.set(sessionId, [
      ...(this.held.get(sessionId) ?? []).filter(entry => !(entry.scrollback === true && entry.value === value)),
      { value, label: marker, marker, until: Number.POSITIVE_INFINITY, scrollback: true },
    ]);
  }

  retime(sessionId: string, marker: string, until: number): void {
    const entries = this.held.get(sessionId);
    if (entries === undefined) return;
    this.held.set(
      sessionId,
      entries.map(entry =>
        entry.marker === marker && entry.scrollback !== true
          ? { ...entry, until: Math.min(entry.until, until) }
          : entry,
      ),
    );
    this.purge();
  }

  scrub(sessionId: string, text: string): string {
    this.purge();
    return mask(this.held.get(sessionId) ?? [], text);
  }

  scrubAll(text: string): string {
    this.purge();
    return mask([...this.held.values()].flat(), text);
  }

  purge(): void {
    const now = this.clock.now();
    for (const [sessionId, entries] of this.held) {
      const live = entries.filter(entry => entry.until > now);
      if (live.length === 0) this.held.delete(sessionId);
      else if (live.length !== entries.length) this.held.set(sessionId, live);
    }
  }

  heldCount(sessionId?: string): number {
    return sessionId === undefined
      ? [...this.held.values()].reduce((total, entries) => total + entries.length, 0)
      : (this.held.get(sessionId)?.length ?? 0);
  }
}

function mask(entries: readonly Held[], text: string): string {
  return [...entries]
    .sort((a, b) => b.value.length - a.value.length)
    .reduce((result, entry) => result.replaceAll(entry.value, entry.marker ?? `[redacted:input ${entry.label}]`), text);
}
