import { AskIdSchema } from '@ferretry/core-asks/contract';
import { err, milliseconds, ok } from '@ferretry/std';
import { StateDraftRepository } from '../drafts/adapters/index.ts';
import { SharedDraftPresence, SharedDraftService, sharedDraftOrigin } from '../drafts/lib/index.ts';
import { sharedDraftRoutes, sharedDraftSocketRoutes } from '../drafts/lib/mounts/shared-drafts.ts';
import { routeTable, socketTable } from '../seams/api.ts';
import { parseSessionId } from '../seams/ferret-id.ts';
import { KeyedSerialExecutor } from '../seams/keyed-serial-executor.ts';
import type { ConversationFeature } from './types.ts';

/** The owner's shared draft: its route and socket, the port's `draft` and `editDraft`, and the draft that goes with an answered item. */
export default {
  id: 'drafts',
  register: f => {
    const { kernel, ferrets, asks, clock } = f;
    const draftSerial = new KeyedSerialExecutor();
    const presence = new SharedDraftPresence();
    const drafts = new SharedDraftService(
      {
        has: async id => (await ferrets.get(parseSessionId(id))) !== undefined,
        hasOpenItem: async (ferret, item) =>
          (await asks.get({ ferret, id: AskIdSchema.parse(item) }))?.state === 'open',
      },
      new StateDraftRepository(kernel.state, draftSerial),
      clock,
      { after: (ms, run) => ({ cancel: kernel.clock.after(milliseconds(ms), run) }) },
      { next: () => String(kernel.ids.mint('draft')) },
    );
    f.late.drafts = drafts;
    return {
      routes: routeTable(sharedDraftRoutes(drafts)),
      sockets: socketTable(
        sharedDraftSocketRoutes(drafts, {
          presence,
          deviceName: async () => undefined,
          nextPeer: () => String(kernel.ids.mint('peer')),
          clock: { nowMs: () => kernel.clock.nowMs() },
        }),
      ),
      port: {
        draft: async (ferret, slot) => await drafts.read(ferret, slot === 'chat' ? undefined : slot),
        editDraft: async (ferret, slot, edit) => {
          try {
            const result = await drafts.edit(
              ferret,
              edit,
              sharedDraftOrigin('admin-cli', 'api', String(kernel.ids.mint('edit'))),
              slot === undefined || slot === 'chat' ? {} : { slot },
            );
            return ok({ applied: result.applied, snapshot: result.snapshot });
          } catch (error) {
            return err({ code: 'draft_refused', message: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      subscribers: {
        // An ask was answered: the draft of its item goes with it (a chat reply keeps the draft).
        'asks.answered': async ({ ferret, askId }) => {
          await drafts.discard(ferret, askId).catch(() => undefined);
        },
      },
    };
  },
} satisfies ConversationFeature;
