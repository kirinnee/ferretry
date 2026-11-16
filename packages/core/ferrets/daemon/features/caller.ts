import { ferretOf } from '@ferretry/core-gate/contract';
import type { CallContext } from '@ferretry/kernel/contract';
import type { FerretId } from '../../contract/index.ts';
import type { ResumeActor } from '../lib/session/resume/types.ts';

/** The code an agent asking for a ferret that is not its own, or its helper's, is refused with (today's). */
export const NOT_OWN_FERRET_CODE = 'not_own_session';

/**
 * The ferret behind a call, from Gate's standing (`ferretOf`, today's `agentSessionOf`): a ferret's own token, or the
 * admin token with a ferret named in `x-ferretry-session-id` (the call's actor is then that ferret's). `undefined` for a
 * person (the admin token with no ferret behind it, a device) and for the Warden, which acts as no ferret.
 */
export function callerFerret(call: CallContext): FerretId | undefined {
  return ferretOf(call);
}

/**
 * Who asked for a resume, for the author recorded beside its turn document (today's `resumeTurnAuthor` input):
 * ATTRIBUTION only, never authority, which the route has already decided. The warden is the Warden; a ferret's token,
 * or the admin token with a ferret behind it, is a peer ferret; a device and the admin UI or CLI are the owner.
 */
export function resumeActorOf(call: CallContext): ResumeActor {
  const credential = call.credential;
  if (credential?.tokenClass === 'warden') return 'warden';
  if (credential?.tokenClass === 'ferret' || callerFerret(call) !== undefined) return 'peer';
  if (credential?.tokenClass === 'device') return 'device';
  if (call.actor === 'admin-cli' || call.actor === 'admin-ui') return call.actor;
  return 'unknown';
}
