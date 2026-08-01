import type { Pin } from '@ferretry/protocol';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import type { PinReferenceResolver, ResolvedPinReference } from './pin-links.ts';
import type { DaemonPinSnapshot } from './pin-store.ts';

const MAX_PIN_REFERENCE_LABEL = 72;

const compactPinLabel = (value: string): string => {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return 'Untitled pin';
  return compact.length <= MAX_PIN_REFERENCE_LABEL
    ? compact
    : `${compact.slice(0, MAX_PIN_REFERENCE_LABEL - 1).trimEnd()}…`;
};

/** Makes an authoritative daemon pin usable in human-facing picker copy. */
export const resolvedPinReference = (scope: DaemonSessionScope, pin: Pin): ResolvedPinReference => {
  const copy = pin.kind === 'note' ? pin.text : pin.preview;
  return { ...scope, pinId: pin.id, label: compactPinLabel(copy || `${pin.kind} pin`) };
};

/** Builds a collision-safe daemon/session/pin identity index from cached boards. */
export const createPinReferenceResolver = (snapshot: DaemonPinSnapshot): PinReferenceResolver => {
  const index = new Map<string, ResolvedPinReference>();
  for (const [scopeKey, board] of snapshot.snapshots) {
    const [daemonId, sessionId] = JSON.parse(scopeKey) as [DaemonSessionScope['daemonId'], string];
    const scope = { daemonId, sessionId };
    for (const pin of board.pins) {
      const resolved = resolvedPinReference(scope, pin);
      index.set(`${scopeKey}\u0000${resolved.pinId}`, resolved);
    }
  }
  return lookup => index.get(`${daemonSessionKey(lookup)}\u0000${lookup.pinId}`) ?? null;
};
