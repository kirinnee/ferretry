/**
 * What changed in the passkey registries: a paired device was forgotten (revoked, so its passkeys went with it), or a
 * catalog member's key was, with its passkeys. Ids only — never a key, a credential or a name.
 */
export type PasskeysChange =
  | { readonly cause: 'device-forgotten'; readonly deviceId: string }
  | { readonly cause: 'member-key-forgotten'; readonly keyId: string };

export type PasskeysChangedListener = (change: PasskeysChange) => Promise<void> | void;

/** Where a failed listener is reported. Never thrown into the removal that fired it. */
export type PasskeysChangedFailure = (error: unknown, change: PasskeysChange) => void;

/** How long a removal waits for its listeners before it answers anyway. */
export const PASSKEYS_CHANGED_WAIT_MS = 5_000;

/** A listener that had not settled when the removal stopped waiting for it. It goes on running; this is reported. */
export class PasskeysChangedListenerTimedOut extends Error {
  constructor(waitedMs: number) {
    super(`a passkeys-changed listener had not finished after ${waitedMs} ms; the removal answered without it`);
    this.name = 'PasskeysChangedListenerTimedOut';
  }
}

/**
 * "THE PASSKEYS CHANGED": told after a passkey is removed, through either route, so whatever keeps a STORED proof (a
 * standing sign-in rule's assertion) can check every one again against the registry as it now stands.
 *
 * Every listener is started at once and the removal waits for them, but only up to `waitMs`: a listener that throws,
 * or has not settled by then, is reported and never holds the removal's answer. A revocation must never be undone,
 * cut short or stalled by a subscriber, and a kept proof is checked again before every use anyway, so a missed or
 * late signal costs a later refusal, never a fill.
 */
export class PasskeysChangedSignal {
  readonly #listeners = new Set<PasskeysChangedListener>();

  constructor(
    private readonly failed: PasskeysChangedFailure = () => undefined,
    private readonly waitMs: number = PASSKEYS_CHANGED_WAIT_MS,
  ) {}

  /** Hears every later change. Returns the call that stops hearing them. */
  subscribe(listener: PasskeysChangedListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async emit(change: PasskeysChange): Promise<void> {
    await Promise.all([...this.#listeners].map(async listener => await this.#heard(listener, change)));
  }

  /** One listener, bounded: settled, failed (reported) or still running past the wait (reported, not awaited). */
  async #heard(listener: PasskeysChangedListener, change: PasskeysChange): Promise<void> {
    const running = Promise.resolve()
      .then(async () => await listener(change))
      .then(
        () => true,
        (error: unknown) => {
          this.failed(error, change);
          return true;
        },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), this.waitMs);
      timer.unref?.();
    });
    const settled = await Promise.race([running, waited]);
    clearTimeout(timer);
    if (!settled) this.failed(new PasskeysChangedListenerTimedOut(this.waitMs), change);
  }
}
