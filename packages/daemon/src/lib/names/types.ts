export const CALLSIGN_WINDOW_MS = 5 * 24 * 60 * 60 * 1_000;
export const MAX_CALLSIGN_LENGTH = 32;
export const MAX_SESSION_TITLE_LENGTH = 120;

export interface NameClaim {
  readonly callsign: string;
  readonly ownerId: string;
  readonly claimedAtMs: number;
  readonly expiresAtMs: number;
}

export type NameClaimAttempt =
  | { readonly claimed: true; readonly claim: NameClaim }
  | { readonly claimed: false; readonly conflict: NameClaim };

/**
 * Persistence must make `tryClaim` atomic across daemon requests. Historical
 * claims remain available from `listClaims` after expiry so reuse policy never
 * depends on mutable session metadata.
 */
export interface NameClaimStore {
  listClaims(): Promise<readonly NameClaim[]>;
  tryClaim(claim: NameClaim): Promise<NameClaimAttempt>;
  release(callsign: string, ownerId: string): Promise<void>;
}

export interface NameRandomSource {
  nextIndex(upperExclusive: number): number;
}

export interface NameAllocationRequest {
  readonly ownerId: string;
  readonly nowMs: number;
  readonly requested?: string;
  readonly fallback?: boolean;
  readonly windowMs?: number;
}

export type NameAllocationSource = 'automatic' | 'requested' | 'fallback';

export type NameAllocationErrorCode =
  | 'invalid_callsign'
  | 'callsign_taken'
  | 'pool_exhausted'
  | 'claim_store_failed'
  | 'random_source_failed';

export interface NameAllocationError {
  readonly code: NameAllocationErrorCode;
  readonly message: string;
  readonly conflict?: NameClaim;
}

export type NameAllocationResult =
  | {
      readonly ok: true;
      readonly claim: NameClaim;
      readonly source: NameAllocationSource;
    }
  | { readonly ok: false; readonly error: NameAllocationError };
