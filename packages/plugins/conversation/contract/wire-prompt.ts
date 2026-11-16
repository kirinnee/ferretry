/** What a ferret's pane is parked on besides a question: the ref of the Agenda card Conversation raises for it. */
import { z } from 'zod';

/** A tool-permission prompt, a harness dialog (a setting, a login, a limit), or the pane's own words for either. */
export const PROMPT_KINDS = ['permission', 'dialog', 'prompt'] as const;

/**
 * The ref of an Asks card of source `prompt` (`ask.sources:prompt`): which kind of wait it is and the prompt's id, a
 * digest of everything a person decides on, so a changed prompt is a new card. Nothing here can answer it: the owner
 * answers in the ferret's own console, and the card closes itself when the wait ends.
 */
export const PromptAskRefSchema = z.strictObject({
  kind: z.enum(PROMPT_KINDS),
  prompt: z.string().min(1).max(128),
});
export type PromptAskRef = z.infer<typeof PromptAskRefSchema>;

/**
 * What Conversation remembers of one ferret's waits on the owner (`state/conversation/<ferret>/prompt-wait.json`): the
 * wait it is in (or was last in), WHICH occurrence of waiting that is, and the card it holds for it. The occurrence is
 * what makes the same prompt a second time a new card (Asks keeps `(source, entry)` for life), and what lets a tick, a
 * race or a restart find the card it already raised instead of raising another.
 */
export const PromptWaitRecordSchema = z.strictObject({
  format: z.literal(1),
  /** The wait now or last: its kind and the prompt's id (`permission:<id>`), never its words. */
  key: z.string().min(1).max(256),
  /** 1 for the first wait; bumped only when a NEW wait starts after the wait was positively seen to end. */
  occurrence: z.number().int().min(1),
  /** Whether the pane was last read as parked on this wait. */
  waiting: z.boolean(),
  /** The card raised for this occurrence: exactly the ref Asks returned (the board it LANDED on) and the entry. */
  ask: z
    .strictObject({
      ferret: z.string().min(1).max(128),
      id: z.string().min(1).max(64),
      entry: z.string().min(1).max(128),
    })
    .optional(),
});
export type PromptWaitRecord = z.infer<typeof PromptWaitRecordSchema>;
