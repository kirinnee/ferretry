/**
 * RESERVED SOURCE REFERENCES (docs/agenda.md § Reserved sourceRefs). An agenda item's `sourceRef` says which of the
 * daemon's producers it belongs to, and some producers ACT on the owner's answer by it: a lane proposal's Accept
 * confirms lanes, a gate item's answer moves a card. So a reference in one of these grammars is the daemon's alone:
 * nothing a ferret controls — a harness question's tool id above all — may ever carry one.
 */
import { MAX_AGENDA_SOURCE_REF_LENGTH } from './agenda.ts';

/**
 * Every grammar a daemon producer writes its `sourceRef` in: lane proposals, gate items and their follow-ups, the
 * Warden's escalations and orphan notices, handovers, budget notices, and the harness's own console prompts.
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
] as const;

/** Whether a reference is written in one of the daemon producers' own grammars. Total. */
export const isDaemonSourceRef = (sourceRef: string | null | undefined): boolean =>
  typeof sourceRef === 'string' && DAEMON_SOURCE_REF_PREFIXES.some(prefix => sourceRef.startsWith(prefix));

/**
 * Whether a harness question's tool id may name its agenda item. A provider's id (Claude's `toolu_…`, Codex's
 * `call_…`) never holds a `:`, and every daemon grammar does, so an id with one — or in a reserved grammar, or
 * too long to store — is refused: the question is not raised from it at all.
 */
export const isHarnessQuestionId = (toolUseId: string): boolean =>
  toolUseId.trim() !== '' &&
  toolUseId.length <= MAX_AGENDA_SOURCE_REF_LENGTH &&
  !toolUseId.includes(':') &&
  !isDaemonSourceRef(toolUseId);
