import { err } from '@ferretry/std';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ConversationApi, ConversationCaller } from './port.ts';

/** The one consumer that may speak as Ferretry's Warden, or press a ferret's composer through the port. */
export const WARDEN_PLUGIN = 'warden';

/**
 * Conversation as ONE consumer sees it (§7.4): the kernel builds this once per plugin that needs the port
 * (`perNeeder`), from that plugin's manifest id, so the id is not something a caller passes or can swap for another's.
 *
 * - `{ kind: 'warden' }` on `send` and `resubmitStuck` is accepted only from the Warden's own plugin. Any other
 *   consumer naming it is refused `forbidden` BEFORE the core is called, so nothing is typed, recorded or read, and a
 *   plugin can never have its words ledgered as the daemon's.
 * - `cancelSend`, `enterSend` and `composer` are the Warden's alone. They type into, or cancel typing in, a ferret's
 *   pane on the person's behalf, and the route's `terminal.use` gate is a gate on a ROUTE CALL that a port consumer
 *   does not carry; no other consumer needs them, so no other consumer gets them. Their shapes do not change.
 *
 * Every other member is the core's, unchanged. The refusals say what is refused and never quote anything.
 */
export function conversationFor(consumer: string, core: ConversationApi): ConversationApi {
  const warden = consumer === WARDEN_PLUGIN;
  const resubmit = core.resubmitStuck?.bind(core);
  const refused = (what: string) => err({ code: 'forbidden', message: `only Ferretry's Warden may ${what}` });
  return {
    ...core,
    send: (ferret, caller, request) =>
      caller.kind === 'warden' && !warden
        ? Promise.resolve(refused('speak as the Warden'))
        : core.send(ferret, caller, request),
    ...(resubmit === undefined
      ? {}
      : {
          resubmitStuck: (ferret: FerretId, caller: ConversationCaller, sendId: string) =>
            warden ? resubmit(ferret, caller, sendId) : Promise.resolve(refused('re-submit a stuck send')),
        }),
    cancelSend: (ferret, sendId) =>
      warden ? core.cancelSend(ferret, sendId) : Promise.resolve(refused("cancel a send's typing through the port")),
    enterSend: (ferret, sendId) =>
      warden ? core.enterSend(ferret, sendId) : Promise.resolve(refused('press Enter for a send through the port')),
    composer: (ferret, action, draft) =>
      warden
        ? core.composer(ferret, action, draft)
        : Promise.resolve(refused("act on a ferret's composer through the port")),
  };
}
