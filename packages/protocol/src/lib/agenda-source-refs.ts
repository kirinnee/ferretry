/**
 * RESERVED SOURCE REFERENCES (docs/agenda.md § Reserved sourceRefs). An agenda item's `sourceRef` says which of the
 * daemon's producers it belongs to, and some producers ACT on the owner's answer by it: a lane proposal's Accept
 * confirms lanes, a gate item's answer moves a card. So a reference in one of these grammars is the daemon's alone:
 * nothing a ferret controls — a harness question's tool id above all — may ever carry one.
 */
import { MAX_AGENDA_SOURCE_REF_LENGTH } from './agenda.ts';

/** The harness's own question items: `question:<the provider's tool id>`, so no other producer's id can collide. */
export const HARNESS_QUESTION_REF_PREFIX = 'question:';

/**
 * Every grammar a daemon producer writes its `sourceRef` in: lane proposals, gate items and their follow-ups, the
 * Warden's escalations and orphan notices, handovers, budget notices, and the harness's own questions and console
 * prompts.
 */
export const DAEMON_SOURCE_REF_PREFIXES = [
  'lanes:',
  'gate:',
  'gate-followup:',
  'warden:',
  'warden-orphan:',
  'handover:',
  'budget:',
  'prompt:',
  HARNESS_QUESTION_REF_PREFIX,
] as const;

/** Whether a reference is written in one of the daemon producers' own grammars. Total. */
export const isDaemonSourceRef = (sourceRef: string | null | undefined): boolean =>
  typeof sourceRef === 'string' && DAEMON_SOURCE_REF_PREFIXES.some(prefix => sourceRef.startsWith(prefix));

/**
 * Whether a harness question's tool id may name its agenda item (`question:<id>`, {@link harnessQuestionRef}). The
 * namespace keeps it apart from every other producer whatever it holds, so a provider's id is taken as written — a
 * colon included (an OpenAI-compatible `functions.Name:0`). Refused: blank, too long to store, or itself in a
 * daemon grammar, which no provider writes.
 */
export const isHarnessQuestionId = (toolUseId: string): boolean =>
  toolUseId.trim() !== '' &&
  HARNESS_QUESTION_REF_PREFIX.length + toolUseId.length <= MAX_AGENDA_SOURCE_REF_LENGTH &&
  !isDaemonSourceRef(toolUseId);

/** The `sourceRef` of the harness's item for a question with this tool id. */
export const harnessQuestionRef = (toolUseId: string): string => `${HARNESS_QUESTION_REF_PREFIX}${toolUseId}`;

/** The tool id a harness question item stands for: its own namespace stripped, or (an item raised before it) as is. */
export const harnessToolUseId = (sourceRef: string): string =>
  sourceRef.startsWith(HARNESS_QUESTION_REF_PREFIX) ? sourceRef.slice(HARNESS_QUESTION_REF_PREFIX.length) : sourceRef;
