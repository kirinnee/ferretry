import type { Cancel } from '@ferretry/kernel/contract';
import type { CredentialProvider, HolderKind } from '../../../contract/index.ts';

/**
 * Follows the `credentials` providers Gate is bound to (G149): when one pushes a notice (`watch`, told every time its
 * `generation()` moves — a revoke, narrowing, unlock, lock or grant change), `told` fires once, so Gate's admission
 * re-asks every open stream at once instead of at the stream's next frame or renewal.
 *
 * The subscription follows the provider: {@link follow} is called with what the hook answers right now, at every
 * admission, so a provider that came, went or was replaced is followed at the next call, and a stopped or absent one
 * drops its subscription. The same provider is never subscribed twice. A provider that does not push, or that cannot
 * be watched, is still asked on every call and frame.
 */
export class CredentialWatch {
  readonly #held = new Map<HolderKind, { readonly provider: CredentialProvider; readonly cancel: Cancel }>();

  constructor(private readonly told: () => void) {}

  /** Subscribes to `provider` (dropping the kind's earlier one when it is a different provider) and hands it back. */
  follow<P extends CredentialProvider | undefined>(kind: HolderKind, provider: P): P {
    const held = this.#held.get(kind);
    if (held?.provider === provider) return provider;
    held?.cancel();
    this.#held.delete(kind);
    if (provider === undefined) return provider;
    try {
      const cancel = provider.watch?.(() => this.told());
      if (cancel !== undefined) this.#held.set(kind, { provider, cancel });
    } catch {
      // A provider that cannot be watched is still asked on every call and frame.
    }
    return provider;
  }

  /** Drops every subscription (the daemon stops). */
  stop(): void {
    for (const { cancel } of this.#held.values()) cancel();
    this.#held.clear();
  }
}
