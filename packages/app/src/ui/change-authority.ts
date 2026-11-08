/**
 * What this browser may change on a machine, read ONCE for every app half that makes a change (today's
 * `readChangeAuthority`, `FleetApplyAuthority` and the grant words of `grantGuidance(…, 'fleet')`).
 *
 * The answer is Gate's `GET /v1/grants` — a core route every caller may read, because a restricted screen must be able
 * to say why it is restricted — narrowed to the `fleet` capability's `configure` axis: whether this caller may change
 * the machine right now, step-up included, and why not. A half reads it through ITS OWN client by route key; this
 * module takes the client and holds nothing at module scope (a grant belongs to a machine, and one browser is paired to
 * several).
 *
 * Pure apart from the one read.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { daemonOfClient } from '../connect/daemon-of.ts';
import { useOptionalShell } from '../shell/context.tsx';
import type { Authority } from '../shell/view-place.tsx';

/** Gate's route. The shell's client sends it as it sends every route key, under the caller's own session. */
export const GRANTS_ROUTE = 'GET /v1/grants' as const;

/** The shared grant vocabulary: why a capability reads the way it does (Gate's `GRANT_REFUSALS`). */
export const CHANGE_REFUSALS = [
  'granted',
  'not-granted',
  'device-not-granted',
  'step-up-required',
  'undetermined',
] as const;
export type ChangeRefusal = (typeof CHANGE_REFUSALS)[number];

/**
 * The part of the grants view this reads: the `fleet` row's `configure` axis. Not strict — Gate owns the rest of the
 * view and may add to it; this takes only the two fields it decides on, and an absent row reads as undetermined.
 */
const GrantsReadSchema = z.object({
  capabilities: z.array(
    z.object({
      capability: z.string(),
      configure: z.boolean(),
      configureRefusal: z.enum(CHANGE_REFUSALS),
    }),
  ),
});

/** What this browser may do with a change on this machine. */
export type ChangeAuthority =
  /** Apply now, and nothing else is asked. */
  | { readonly kind: 'open' }
  /** Allowed once this device confirms with its passkey, which the carrier asks for when the daemon does. */
  | { readonly kind: 'step-up' }
  /** Refused for a reason a passkey would not fix — switched off, not granted, an unreadable grant document. */
  | { readonly kind: 'refused'; readonly refusal: ChangeRefusal }
  /**
   * This browser never learned what it may do here, because the read failed.
   *
   * DELIBERATELY NOT `refused`: that would put a sentence about the operator's decisions on screen on the strength of
   * no answer at all.
   */
  | { readonly kind: 'unreadable' };

/** The sentence a refusal of the `fleet` capability reads as, in the shared grant vocabulary. */
export const changeRefusalExplanation = (refusal: ChangeRefusal): string => {
  switch (refusal) {
    case 'granted':
      return 'The operator allows this.';
    case 'not-granted':
      return 'The operator of this machine switched off the agent fleet for paired devices, this browser included. It is turned back on at the machine with `fy`.';
    case 'device-not-granted':
      return 'This machine allows the agent fleet, but this device has not been given it. Widen this device at the machine with `fy device grant <device> fleet --use`, or from a device that holds it and can configure pairing.';
    case 'step-up-required':
      return 'Using or changing the agent fleet from here needs your passkey. Confirm on this device and it goes ahead.';
    case 'undetermined':
      return 'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.';
  }
};

/** The authority a grants answer gives. An answer with no `fleet` row is the stricter reading, never an open button. */
export function changeAuthorityOf(answer: unknown): ChangeAuthority {
  const read = GrantsReadSchema.safeParse(answer);
  if (!read.success) return { kind: 'unreadable' };
  const fleet = read.data.capabilities.find(row => row.capability === 'fleet');
  if (fleet === undefined) return { kind: 'refused', refusal: 'undetermined' };
  if (fleet.configure) return { kind: 'open' };
  return fleet.configureRefusal === 'step-up-required'
    ? { kind: 'step-up' }
    : { kind: 'refused', refusal: fleet.configureRefusal };
}

/** What this browser may change on this machine. Never throws. */
export const readChangeAuthority = async (client: Pick<PluginClient, 'call'>): Promise<ChangeAuthority> => {
  try {
    return changeAuthorityOf(await client.call(GRANTS_ROUTE));
  } catch {
    return { kind: 'unreadable' };
  }
};

/**
 * The shell's tri-state authority (S1) in this module's older vocabulary (R2 m3), so the callers of
 * {@link useChangeAuthority} keep their type: `unknown` is `null` (loading, as before); `locked` is `step-up`
 * ("allowed once this device confirms with its passkey"); the others as they are.
 */
export function changeAuthorityFrom(authority: Authority): ChangeAuthority | null {
  switch (authority.kind) {
    case 'unknown':
      return null;
    case 'locked':
    case 'step-up':
      return STEP_UP;
    case 'open':
      return OPEN;
    case 'unreadable':
      return UNREADABLE;
    case 'refused':
      return authority;
  }
}

const OPEN: ChangeAuthority = Object.freeze({ kind: 'open' });
const STEP_UP: ChangeAuthority = Object.freeze({ kind: 'step-up' });
const UNREADABLE: ChangeAuthority = Object.freeze({ kind: 'unreadable' });
const noSubscription = (): (() => void) => () => {};

/**
 * The authority for one machine's client; `null` while it is being read. A new client starts over.
 *
 * Inside an app shell, for a client the shell issued, it is a thin read of the shell's ONE per-daemon grants cache
 * (S1, M6) for `fleet`/`configure`: no second `GET /v1/grants`. Outside a shell, or for a client the shell did not
 * issue (a plugin's own harness, a suite's fake), it reads as it always did: its own `GET /v1/grants` (R3 m4).
 */
export function useChangeAuthority(client: Pick<PluginClient, 'call'>): ChangeAuthority | null {
  const runtime = useOptionalShell()?.runtime;
  const daemon = daemonOfClient(client);
  const cached = runtime !== undefined && daemon !== undefined;
  const readCache = useCallback(
    () => (runtime === undefined || daemon === undefined ? null : runtime.authority(daemon, 'fleet', 'configure')),
    [runtime, daemon],
  );
  const fromCache = useSyncExternalStore(cached ? runtime.subscribe : noSubscription, readCache, readCache);
  const [own, setOwn] = useState<ChangeAuthority | null>(null);
  useEffect(() => {
    if (cached) return;
    let live = true;
    setOwn(null);
    void readChangeAuthority(client).then(next => {
      if (live) setOwn(next);
    });
    return () => {
      live = false;
    };
  }, [client, cached]);
  return fromCache === null ? own : changeAuthorityFrom(fromCache);
}
