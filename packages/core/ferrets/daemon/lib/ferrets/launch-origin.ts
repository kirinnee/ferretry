import { callerIsAgent as gateCallerIsAgent, ferretOf } from '@ferretry/core-gate/contract';
import { AGENT_ORIGIN, type LaunchOrigin, PERSON_ORIGIN } from '../../../contract/index.ts';

/** The standing Gate stamped on a call: its credential and actor, and nothing the request body says. */
type Standing = Parameters<typeof ferretOf>[0];

/** Whether the caller is an agent (a ferret's token, the warden, or the admin token with a ferret behind it): Gate's one predicate. */
export const callerIsAgent = (call: Standing): boolean => gateCallerIsAgent(call.credential, call.actor);

/**
 * Who a call's launch is FOR, from the admitted credential alone: an agent (naming the ferret behind it when there is
 * one — the Warden's token has none) or a person. It reads no attribution field, no header and no body: the same
 * `callerIsAgent` decision every route here makes.
 */
export function launchOriginOf(call: Standing): LaunchOrigin {
  if (!callerIsAgent(call)) return PERSON_ORIGIN;
  const ferret = ferretOf(call);
  return ferret === undefined ? AGENT_ORIGIN : { kind: 'agent', ferret };
}
