/**
 * What Codex is asked when it compacts a conversation (`-c compact_prompt=...`): the setting REPLACES Codex's own summary
 * prompt, so this text asks for the summary itself AND for what Ferretry needs kept in it. Claude gets the same two texts
 * from hooks; here they ride in the summary request, and the summary ends with the re-read instructions, so the ferret
 * reads them first when it resumes.
 *
 * The pane's `FY_SESSION_ID` is left for the shell to expand: the ferret's own commands read it.
 */
import { COMPACTION_KEEP_LINES, compactionReabsorbLines } from '@ferretry/core-ferrets/contract';

/** The Codex config key its compaction (summary) prompt is read from. */
export const CODEX_COMPACT_PROMPT_KEY = 'compact_prompt';

/** The session id as the ferret's own shell spells it. */
const SESSION = '$FY_SESSION_ID';

/** The compaction prompt: the summary Codex needs, what it must keep, and what the resumed ferret must re-read. */
export const CODEX_COMPACT_PROMPT = [
  'Write a handoff summary of this conversation for the agent that will resume the work: progress so far, key decisions, constraints, and what remains.',
  ...COMPACTION_KEEP_LINES,
  'End the summary with these instructions, word for word:',
  ...compactionReabsorbLines(SESSION),
].join('\n');
