import { z } from 'zod';
import type { FerretId } from '@ferretry/kernel/contract';
import type { FerretBirth } from './ids.ts';

/**
 * WHO a launch is for, as the admitted credential decided it — separate from the attribution a resume's turn names
 * (`ResumeOptions.actor`), which changes no policy.
 *
 * - `person`: the owner, or a device they paired (the admin token with no ferret behind it, a device).
 * - `daemon`: the daemon's own recovery with no caller behind it (the boot auto-resume), which is not fenced.
 * - `agent`: a ferret's token, the Warden, or the admin token with a ferret behind it. `ferret` names the ferret when
 *   there is one (the Warden has none). An agent's launch binds its folder under the state-home policy: it never
 *   launches into the daemon's state home.
 *
 * Every Ferrets entry that can (re)launch a process takes one, REQUIRED and with no default, so a caller that forgets
 * to say who it acts for does not compile. Whatever cannot be told (a queued item stored without one) is an agent.
 */
export type LaunchOrigin =
  | { readonly kind: 'person' }
  | { readonly kind: 'daemon' }
  | { readonly kind: 'agent'; readonly ferret?: FerretId };

export const LaunchOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person') }),
  z.strictObject({ kind: z.literal('daemon') }),
  z.strictObject({
    kind: z.literal('agent'),
    ferret: z.custom<FerretId>(value => typeof value === 'string' && value.length > 0).optional(),
  }),
]);

/** The owner or a device of theirs. */
export const PERSON_ORIGIN: LaunchOrigin = { kind: 'person' };
/** The daemon's own recovery. */
export const DAEMON_ORIGIN: LaunchOrigin = { kind: 'daemon' };
/** An agent with no ferret behind it (the Warden, a sweep, a queued item whose origin was never kept): fails closed. */
export const AGENT_ORIGIN: LaunchOrigin = { kind: 'agent' };

/** Whether the launch is fenced out of the state home: only an agent's is. */
export const originIsAgent = (origin: LaunchOrigin): boolean => origin.kind === 'agent';

/** The birth a record keeps for a start made under `origin`: the origin's own kind, nothing else. */
export const birthOf = (origin: LaunchOrigin): FerretBirth => origin.kind;

/**
 * Whether a launch is FENCED out of the state home. It is when this call's origin is an agent, OR the ferret was first
 * started by an agent, OR its birth is missing (a record that never said who started it, or one that cannot be read):
 * a doubt fences, so only a recorded `person` or `daemon` birth under a non-agent call launches unfenced.
 */
export const launchIsFenced = (origin: LaunchOrigin, birth: FerretBirth | undefined): boolean =>
  originIsAgent(origin) || birth === undefined || birth === 'agent';
