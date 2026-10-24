/**
 * What a person is told when a structured answer could not be delivered.
 *
 * The driver's own sentences ("the rendered form is not the exact pending question; no keys were
 * sent…") are evidence for whoever debugs the pane, not instructions for whoever is holding a phone.
 * They travel as the refusal's `detail`; the sentence below is what the screen leads with, and it names
 * the two ways the person can still answer.
 */
export const ANSWER_NOT_DELIVERED =
  "Couldn't answer automatically. Answer it in the Console tab, or type your choice in chat.";

/** For an earlier attempt that may have reached the form: answering again could answer something else. */
export const ANSWER_MAY_HAVE_LANDED =
  'An earlier answer may already have reached this question. Check the Console tab before answering again.';

/** For a request from an app built before answers carried their own id. */
export const RELOAD_THE_APP = 'This app is out of date for this question. Reload the app, then answer again.';

/**
 * Whether a request id has the shape the app minted before #771: `question:<daemon>:<session>:<tool>`,
 * one id per QUESTION. The current app adds a digest of the answer as a fifth part, so one id is one
 * answer. A stale app that re-sends a changed answer under its old id is refused as a reused id — and
 * the remedy for that is a reload, not anything about the answer.
 */
export function isQuestionScopedRequestId(requestId: string): boolean {
  return /^question:[^:]+:[^:]+:[^:]+$/u.test(requestId);
}
