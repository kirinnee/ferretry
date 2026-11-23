/**
 * What Codex is asked when it compacts a conversation (`-c compact_prompt=...`): the setting REPLACES Codex's own summary
 * prompt, so this text asks for the summary itself AND for what Ferretry needs kept in it. Claude gets the same two texts
 * from hooks; here they ride in the summary request, and the summary ends with the re-read instructions, so the ferret
 * reads them first when it resumes.
 *
 * The ferret's session id is written into the text when the prompt is composed at launch. Codex does not expand a shell
 * variable inside a prompt, so a `$FY_SESSION_ID` left in it would reach the agent as the variable's name, not its id.
 */
import { type CompactionExtras, compactionKeepLines, compactionReabsorbLines } from '@ferretry/core-ferrets/contract';

/** The Codex config key its compaction (summary) prompt is read from. */
export const CODEX_COMPACT_PROMPT_KEY = 'compact_prompt';

/** The compaction prompt for one ferret: the summary Codex needs, what it must keep, and what the resumed ferret must re-read. */
export const codexCompactPrompt = (session: string, extras?: CompactionExtras): string =>
  [
    'Write a handoff summary of this conversation for the agent that will resume the work: progress so far, key decisions, constraints, and what remains.',
    ...compactionKeepLines(extras),
    'End the summary with these instructions, word for word:',
    ...compactionReabsorbLines(session, extras),
  ].join('\n');
