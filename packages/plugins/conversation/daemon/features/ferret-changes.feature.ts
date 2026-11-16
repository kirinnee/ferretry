import { followFerretChanges, followFerretStopping } from '../ferret-changes.ts';
import { built, type ConversationFeature } from './types.ts';

/**
 * What Conversation does when Ferrets says a ferret is stopping or changed: the attachment plaintext is zeroed, the turn
 * boundaries look, the question and prompt watches look, and a stopped ferret's question is withdrawn. It fans out to
 * the features that own each (through `f.late`), so it is the one place that knows all of them.
 */
export default {
  id: 'ferret-changes',
  register: f => ({
    hooks: () => ({
      // A stop is being attempted: the unlocked attachments are zeroed before it can fail.
      'ferret.stopping': followFerretStopping({
        release: ferret => built(f.late.reading, 'reading half').release(ferret),
      }),
      // A ferret stopped or is gone: its unlocked attachments are zeroed first; every change is a turn look.
      'ferret.changed': followFerretChanges({
        release: ferret => built(f.late.reading, 'reading half').release(ferret),
        look: (ferret, phase) => built(f.late.turns, 'turns').look(ferret, phase),
        lookQuestion: ferret => built(f.late.questions, 'question watch').look(ferret),
        lookPrompt: ferret => built(f.late.prompts, 'prompt watch').changed(ferret),
        forget: ferret => built(f.late.turns, 'turns').forget(ferret),
        withdrawQuestion: ferret =>
          void built(f.late.questions, 'question watch')
            .withdraw(ferret)
            .catch((error: unknown) =>
              f.kernel.log.warn(`conversation could not withdraw the question of ${ferret}: ${String(error)}`),
            ),
        warn: message => f.kernel.log.warn(message),
      }),
    }),
  }),
} satisfies ConversationFeature;
