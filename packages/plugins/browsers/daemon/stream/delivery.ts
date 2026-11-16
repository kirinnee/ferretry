import { type SealedGate, SEALED_STREAM_REFUSAL, type SealedStamp } from '../sealed/gate.ts';
import type { ViewerDeliveryGuard } from './viewer-contracts.ts';
import { VIEWER_SCOPE_REFUSAL, type ViewerScope, type ViewerScopeStamp } from './viewer-scope.ts';

/**
 * THE ONE DELIVERY GUARD of an agent's viewer stream, made of the rules that say whether a frame may reach a ferret:
 * sealed output (a value Accounts holds in this browser: no picture of it, ever) and scope (the page is the ferret's own and
 * nobody holds it). Each is a {@link ViewerDeliveryGuard}; {@link allOf} makes them one, which the viewer host asks when a
 * frame arrives (stamp), after every await (mayDeliver), and the stream asks again before every send, every retry and every
 * chunk, and hands to the transport as its send permit. A person's stream has none.
 */

/** The sealed gate as a delivery guard: any value sealed since the frame arrived, or alive when it did, withholds it. */
export function sealedDelivery(gate: SealedGate): ViewerDeliveryGuard {
  return {
    stamp: () => gate.stamp(),
    mayDeliver: since => gate.mayDeliver('agent', since as SealedStamp, { picture: true }),
    refusal: SEALED_STREAM_REFUSAL,
    watch: onRevoked => gate.onSeal(() => onRevoked(SEALED_STREAM_REFUSAL)),
  };
}

/** The scope rule as a delivery guard for one ferret's viewer. */
export function scopeDelivery(scope: ViewerScope, ferret: string): ViewerDeliveryGuard {
  let watching: string | undefined;
  return {
    stamp: page => {
      if (page !== undefined) watching = page;
      return scope.stamp(ferret, page ?? '');
    },
    mayDeliver: stamp => scope.valid(stamp as ViewerScopeStamp),
    refusal: VIEWER_SCOPE_REFUSAL,
    admit: async page => await scope.admit(ferret, page),
    watch: onRevoked => {
      const stopListening = scope.onRevoked((who, page) => {
        // Any page when none has been seen yet; otherwise the one this viewer was last sent.
        if (who === ferret && (watching === undefined || watching === page)) onRevoked(VIEWER_SCOPE_REFUSAL);
      });
      const stopChecking = scope.recheck(ferret, () => watching);
      return () => {
        stopListening();
        stopChecking();
      };
    },
  };
}

/** The guards as one: a frame leaves only if every guard says so, and the sentence is the one of the guard that said no. */
export function allOf(guards: readonly ViewerDeliveryGuard[]): ViewerDeliveryGuard {
  let refusal = guards[0]?.refusal ?? '';
  return {
    stamp: page => guards.map(guard => guard.stamp(page)),
    mayDeliver: stamp => {
      const stamps = stamp as readonly unknown[];
      for (const [index, guard] of guards.entries()) {
        if (guard.mayDeliver(stamps[index])) continue;
        refusal = guard.refusal;
        return false;
      }
      return true;
    },
    get refusal() {
      return refusal;
    },
    admit: async page => {
      for (const guard of guards) {
        if (guard.admit !== undefined && !(await guard.admit(page))) {
          refusal = guard.refusal;
          return false;
        }
      }
      return true;
    },
    watch: onRevoked => {
      const stops = guards.map(guard => guard.watch?.(onRevoked));
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
}
