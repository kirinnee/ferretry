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
