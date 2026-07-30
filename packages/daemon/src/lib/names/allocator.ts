import { availableCallsigns, normalizeCallsign } from './policy.ts';
import { DEFAULT_CALLSIGN_POOL } from './pool.ts';
import {
  CALLSIGN_WINDOW_MS,
  type NameAllocationRequest,
  type NameAllocationResult,
  type NameClaim,
  type NameClaimAttempt,
  type NameClaimStore,
  type NameRandomSource,
} from './types.ts';

function storeFailure(error: unknown): NameAllocationResult {
  return {
    ok: false,
    error: {
      code: 'claim_store_failed',
      message: `callsign persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  };
}

export class NameAllocator {
  constructor(
    private readonly store: NameClaimStore,
    private readonly random: NameRandomSource,
    private readonly pool: readonly string[] = DEFAULT_CALLSIGN_POOL,
  ) {}

  async allocate(request: NameAllocationRequest): Promise<NameAllocationResult> {
    const windowMs = Math.max(1, Math.floor(request.windowMs ?? CALLSIGN_WINDOW_MS));
    const requested = request.requested?.trim();
    let extraConflict: NameClaim | undefined;

    if (requested) {
      const callsign = normalizeCallsign(requested);
      if (callsign === null) {
        return {
          ok: false,
          error: {
            code: 'invalid_callsign',
            message: 'callsign must start with a letter and contain only letters, digits, or hyphens',
          },
        };
      }

      const claim: NameClaim = {
        callsign,
        ownerId: request.ownerId,
        claimedAtMs: request.nowMs,
        expiresAtMs: request.nowMs + windowMs,
      };
      let attempt: NameClaimAttempt;
      try {
        attempt = await this.store.tryClaim(claim);
      } catch (error) {
        return storeFailure(error);
      }
      if (attempt.claimed) return { ok: true, claim: attempt.claim, source: 'requested' };
      if (!request.fallback) {
        return {
          ok: false,
          error: {
            code: 'callsign_taken',
            message: `callsign ${JSON.stringify(callsign)} is already claimed`,
            conflict: attempt.conflict,
          },
        };
      }
      extraConflict = attempt.conflict;
    }

    let claims: readonly NameClaim[];
    try {
      const stored = await this.store.listClaims();
      claims = extraConflict === undefined ? stored : [...stored, extraConflict];
    } catch (error) {
      return storeFailure(error);
    }

    if (this.pool.length === 0) {
      return { ok: false, error: { code: 'pool_exhausted', message: 'no callsigns are configured' } };
    }

    let startIndex: number;
    try {
      startIndex = this.random.nextIndex(this.pool.length);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'random_source_failed',
          message: `callsign random source failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= this.pool.length) {
      return {
        ok: false,
        error: { code: 'random_source_failed', message: 'callsign random source returned an invalid index' },
      };
    }

    const source = requested ? ('fallback' as const) : ('automatic' as const);
    for (const callsign of availableCallsigns(this.pool, claims, request.nowMs, startIndex)) {
      const claim: NameClaim = {
        callsign,
        ownerId: request.ownerId,
        claimedAtMs: request.nowMs,
        expiresAtMs: request.nowMs + windowMs,
      };
      let attempt: NameClaimAttempt;
      try {
        attempt = await this.store.tryClaim(claim);
      } catch (error) {
        return storeFailure(error);
      }
      if (attempt.claimed) return { ok: true, claim: attempt.claim, source };
    }

    return {
      ok: false,
      error: {
        code: 'pool_exhausted',
        message: 'every callsign is claimed in the active resolution window',
      },
    };
  }
}
