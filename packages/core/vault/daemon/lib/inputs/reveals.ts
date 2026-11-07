import { isFerretCall, ownerOnlyWords } from '@ferretry/core-gate/contract';
import type { CallContext, FerretId, RevealGrant, TargetKind } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import type { TerminalRevealRefusal } from '../../../contract/index.ts';
import { ownerOf } from '../runtime/mounts/inputs.ts';
import { InputRequestError } from './errors.ts';
import type { InputRequestService } from './service.ts';

/**
 * How long one "Show anyway" lasts at most: the passkey unlock a device holds (8 h), so no reveal outlives the unlock
 * that let its connection open. Today's reveal lasted for its connection, and the connection still drops it when it
 * closes; a longer-lived connection falls back to the notice, the stricter side.
 */
export const REVEAL_GRANT_MS = 8 * 60 * 60_000;

const TERMINAL = 'terminal' as TargetKind;

/**
 * THE REVEALS THIS VAULT MINTED (§4.7: "minted by Vault only"). `RevealGrant` is a branded shape, and a brand is a
 * compile-time fact: any plugin could cast `{ target, until }` into one. So the holds honour only an object this
 * registry minted, by identity, and a copy, a spread or a forged shape is not a reveal. Memory only: a restart ends
 * every reveal, exactly as it ends every viewer connection.
 */
export class RevealGrants {
  readonly #minted = new WeakSet<object>();

  constructor(private readonly nowMs: () => number) {}

  /** A reveal of one terminal for {@link REVEAL_GRANT_MS}; frozen, so its target and expiry cannot be widened. */
  mint(key: string): RevealGrant {
    const grant = Object.freeze({
      target: Object.freeze({ kind: TERMINAL, key }),
      until: new Date(this.nowMs() + REVEAL_GRANT_MS).toISOString(),
    });
    this.#minted.add(grant);
    return grant as unknown as RevealGrant;
  }

  /** Whether this registry minted exactly this object. */
  minted(grant: RevealGrant): boolean {
    return typeof grant === 'object' && grant !== null && this.#minted.has(grant);
  }
}

const NOT_OWNER: TerminalRevealRefusal = {
  refused: 'owner_only',
  sentence: ownerOnlyWords('chooses to see a held terminal'),
};

/**
 * `VaultApi.grantTerminalReveal` (I77, I83), today's socket path (`mounts/terminals.ts` `reveal` → `revealed`):
 * the owner gate first, then the audit record, and only then a grant. The order is the guarantee — a reveal that
 * could not be recorded is never minted, so it cannot be honoured.
 */
export async function grantTerminalReveal(
  service: Pick<InputRequestService, 'revealed'>,
  grants: Pick<RevealGrants, 'mint'>,
  ferret: FerretId,
  key: string,
  caller: CallContext,
): Promise<Result<RevealGrant, TerminalRevealRefusal>> {
  // A ferret, the warden, or a call that carries no credential at all is not the owner (stricter than a route,
  // which is never reached without one).
  if (caller.credential === undefined || isFerretCall(caller)) return err(NOT_OWNER);
  try {
    await service.revealed(ownerOf(caller), ferret, key);
  } catch (error) {
    if (!(error instanceof InputRequestError)) throw error;
    return err(error.code === 'forbidden' ? NOT_OWNER : { refused: 'unrecorded', sentence: error.message });
  }
  return ok(grants.mint(key));
}
