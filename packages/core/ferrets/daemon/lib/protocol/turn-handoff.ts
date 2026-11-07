/**
 * How the daemon hands an agent a message through a FILE, and how the app reads that hand-off back.
 *
 * WHY A FILE. A long, multi-line or attached message typed into a terminal composer gets mangled —
 * quoting, paste handling and line breaks each turn one message into several — so the daemon writes the
 * message to a document in the session's own directory and types one short line that points at it. The
 * agent's transcript therefore records THAT line as what "the user" said, and an app that showed it
 * verbatim drew a bubble reading "Read the file …/turn-008.md now, then carefully follow every
 * instruction inside it" where the person's own words belong — which reads exactly like an injected
 * instruction.
 *
 * ONE OWNER FOR BOTH ENDS, for the reason `agent-messages.ts` gives: the daemon writes these sentences
 * and the app recognises them, the two live in packages that may not import one another, and a pointer
 * the daemon rewords while the app still matches the old wording would silently put the raw instruction
 * back in the person's bubble. So every sentence and document shape is written once, here, beside the
 * parser that reads it.
 *
 * THE PARSERS DEGRADE ONE WAY. A pointer is recognised only as the WHOLE message, so a person who quotes
 * one inside their own sentence keeps their sentence; and a document whose attachment list does not have
 * exactly the shape written below is returned as text rather than half-stripped.
 */

/** What follows the path in a turn pointer. */
const TURN_POINTER_TAIL =
  ' now, then carefully follow every instruction inside it. This is your complete task for this turn.';
const TURN_POINTER_HEAD = 'Read the file ';

/** What is typed into a ready pane so the agent picks up the turn written to `turnFile`. */
export function turnFileInstruction(turnFile: string): string {
  return `${TURN_POINTER_HEAD}${turnFile}${TURN_POINTER_TAIL}`;
}

/** How the turn-one document opens, above the task it assigns. */
const ASSIGNED_TASK_HEADING = '# Assigned task\n\n';

/** The turn-one document an agent reads. */
export function assignedTaskDocument(prompt: string): string {
  return `${ASSIGNED_TASK_HEADING}${prompt}\n`;
}
