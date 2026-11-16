import { PromptAskRefSchema } from '../../contract/index.ts';
import { PromptAsks } from '../prompts/adapters/prompt-asks.ts';
import { StatePromptRecords } from '../prompts/adapters/state-prompt-records.ts';
import type { PromptRead } from '../prompts/lib/prompt-wait.ts';
import { parseSessionId } from '../seams/ferret-id.ts';
import type { ConversationFeature } from './types.ts';

/**
 * The Agenda's card for a ferret parked on a permission prompt or a dialog (Asks' source `prompt`). The questions
 * feature's 2 s watch calls `f.late.prompts.sweep` once per tick, between the Agenda's reconcile and the
 * question look, so the one cadence keeps its order.
 */
export default {
  id: 'prompts',
  register: f => {
    const { kernel, ferrets, asks } = f;
    const promptAsks = new PromptAsks(
      asks,
      async ferret => (await ferrets.prompt?.(parseSessionId(ferret))) as PromptRead | undefined,
      new StatePromptRecords(kernel.state),
      message => kernel.log.warn(message),
    );
    /** Said once until the ferret list reads again, not on every 2 s look. */
    let promptRosterFailing = false;
    f.late.prompts = {
      // Ferrets said a ferret changed state: its pane is read for a prompt on the next 2 s sweep, and no other ferret's is.
      changed: ferret => promptAsks.changed(ferret),
      // A pane is read only for a ferret Ferrets reported changed, one owed a card, or once after boot: never every tick.
      sweep: async () => {
        await ferrets.list().then(
          async roster => {
            promptRosterFailing = false;
            await promptAsks.sweep(roster.map(ferret => ({ id: ferret.id, state: ferret.state })));
          },
          error => {
            if (!promptRosterFailing)
              kernel.log.warn(`conversation could not list the ferrets for their prompts: ${String(error)}`);
            promptRosterFailing = true;
          },
        );
      },
    };
    return {
      // A ferret parked on a permission prompt or a dialog is a card the owner cannot answer here: the console does.
      hooks: () => ({ 'ask.sources:prompt': { schema: PromptAskRefSchema, title: 'Prompt', form: false } }),
    };
  },
} satisfies ConversationFeature;
