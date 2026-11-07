import type { SystemCallsignPrefix } from '@ferretry/protocol';
import { startWithSystemCallsign, type SystemCallsignIssuer } from '../../names/index.ts';
import { SessionControlError, type SessionControlSubsystem } from './session-control.ts';

/**
 * Session control for a SYSTEM session — the Learning miner, Pack clean-up — whose every start carries a
 * callsign of the system's own (`learning-000001`, `pack-000001`) instead of drawing a first name from
 * the human pool. The caller's request is stamped with the id, with no fallback to the pool, and its
 * payload re-serialized to match so the start's idempotency digest describes the request actually sent.
 * A start refused because the id was taken takes the next one and retries once.
 */
export function withSystemCallsign(
  control: SessionControlSubsystem,
  issuer: SystemCallsignIssuer,
  prefix: SystemCallsignPrefix,
): SessionControlSubsystem {
  return {
    start: async (request, requestId, _payload, _delegation, caller) =>
      await startWithSystemCallsign(
        issuer,
        prefix,
        error => error instanceof SessionControlError && error.failure === 'callsign_taken',
        async teammate => {
          const named = { ...request, teammate };
          return await control.start(named, requestId, JSON.stringify(named), undefined, caller);
        },
      ),
    stop: async (sessionId, reason) => await control.stop(sessionId, reason),
    recover: async (requestId, payloadDigest) => await control.recover(requestId, payloadDigest),
  };
}
