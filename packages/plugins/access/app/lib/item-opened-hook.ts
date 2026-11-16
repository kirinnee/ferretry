/**
 * THE `agenda.item-opened` HOOK ACCESS PROVIDES TO AGENDA: the owner opened an ask, so this device closes its own
 * alert lines for it and the machine is told (`agendaItemOpenedHandler`, `push-seen.ts`). Agenda says only WHEN: it
 * offers the hook name and the value's shape (`agenda/contract/app-hooks.ts`) and hands over the machine's seen mark
 * (`POST /v1/push/seen` is Agenda's route, so Access never calls it); the alert lines are Access's, so Access decides
 * where in closing them to make that call. Neither half imports the other.
 *
 * Built once per daemon. Total: the handler never rejects, and a browser with no push worker for the machine, or a seen
 * mark that did not land, only leaves lines up.
 */

import { PushSeenResponseSchema } from '../../contract/index.ts';
import { daemonId } from '../shell-pairing.ts';
import { type AgendaItemOpenedPorts, agendaItemOpenedHandler, machinePushRegistration } from './push-seen.ts';

/** What the shell hands a provider's factory; only the daemon is read. */
export interface ItemOpenedContext {
  readonly daemon: string;
}

/** The machine's seen mark, as Agenda hands it: answers what the machine's clear named. */
type SeenMark = () => Promise<unknown>;

/** The hook's factory over a browser's registrations: its value is `(ferret, ask, seen) => …`, as Agenda reads it. */
export const agendaItemOpenedHook =
  (registration: AgendaItemOpenedPorts['registration'], now?: () => number) =>
  ({ daemon }: ItemOpenedContext): ((ferret: string, ask: string, seen: SeenMark) => Promise<unknown>) => {
    const machine = { daemonId: daemonId(daemon) };
    return (ferret, ask, seen) =>
      agendaItemOpenedHandler({
        registration,
        ...(now === undefined ? {} : { now }),
        seen: async () => PushSeenResponseSchema.parse(await seen()),
      })(machine, ferret, ask);
  };

/** This page's push registration for one machine, read from the browser at the moment of the open. */
export const pageRegistration: AgendaItemOpenedPorts['registration'] = daemon =>
  machinePushRegistration(globalThis.navigator, globalThis.location?.origin ?? 'http://localhost')(daemon);
