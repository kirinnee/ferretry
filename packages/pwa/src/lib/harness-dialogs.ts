/**
 * A HARNESS DIALOG, in the browser: the one call that answers it, and the plain words every surface
 * uses for it.
 *
 * Codex's "Hooks need review", its sign-in screen, Claude's "New MCP server found" — the daemon reads
 * them off the agent's own pane (`SessionState.harnessDialog`) and answers one only while the pane still
 * shows that very dialog. The dialog card, the session list, the top bar and the notification are all
 * built from the helpers below, so the four surfaces cannot describe one dialog four ways.
 */

import {
  FY_REQUEST_ID_HEADER,
  type Harness,
  type HarnessDialog,
  type HarnessDialogAnswerRequest,
  HarnessDialogAnswerRequestSchema,
  type HarnessDialogAnswerResult,
  HarnessDialogAnswerResultSchema,
  type HarnessDialogKind,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** The refusal code for a dialog the pane no longer shows. */
export const HARNESS_DIALOG_GONE = 'harness_dialog_gone';

/**
 * The dialog this answer was for is no longer on the agent's screen — answered at the machine, timed
 * out, or replaced by another. Nothing was typed; the page must re-read the session.
 */
export class HarnessDialogGone extends DaemonResponseError {
  constructor(message: string) {
    super(409, message, HARNESS_DIALOG_GONE);
    this.name = 'HarnessDialogGone';
  }
}

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  if (response.status === 409 && body.code === HARNESS_DIALOG_GONE) return new HarnessDialogGone(message);
  return new DaemonResponseError(response.status, message, typeof body.code === 'string' ? body.code : undefined);
};

/**
 * Answers the dialog on the session's pane, on the daemon that owns it.
 *
 * Governed as the Console is (`terminal.use`), so a refusal comes back as the same grant error a
 * Console write raises. `cleared: false` means the keys landed and the same dialog is still up: the
 * caller says so and never sends them again by itself.
 */
export const answerHarnessDialog = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  answer: HarnessDialogAnswerRequest,
  fetcher: DaemonFetch = browserFetch,
): Promise<HarnessDialogAnswerResult> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('dialog scope must belong to the requested daemon');
  const request = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(scope.sessionId)}/dialog`, {
    method: 'POST',
    body: JSON.stringify(HarnessDialogAnswerRequestSchema.parse(answer)),
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  const result = HarnessDialogAnswerResultSchema.parse(await response.json());
  if (result.dialogId !== answer.dialogId) throw new DaemonResponseError(502, 'daemon answered another dialog');
  return result;
};

/* ---------- plain words ---------------------------------------------------- */

/** The harness as a person names it. */
export const harnessWord = (harness: Harness): string => (harness === 'codex' ? 'Codex' : 'Claude Code');

/** The card's heading: "Hadi’s Codex is waiting: Hooks need review". */
export const harnessDialogSentence = (agent: string, dialog: HarnessDialog): string =>
  `${agent}’s ${harnessWord(dialog.harness)} is waiting: ${dialog.title}`;

/** The notification and status line: "Hadi is waiting on Codex: Hooks need review". */
export const harnessDialogNotice = (agent: string, dialog: HarnessDialog): string =>
  `${agent} is waiting on ${harnessWord(dialog.harness)}: ${dialog.title}`;

/** What choosing a trust-granting option does, in the app's words — `undefined` for a kind that grants none. */
const TRUST_NOTE: Readonly<Partial<Record<HarnessDialogKind, string>>> = {
  'hooks-review': 'Trusts these to run outside the sandbox',
  'mcp-servers': 'Lets this MCP server run',
};

export const harnessTrustNote = (dialog: HarnessDialog): string => TRUST_NOTE[dialog.kind] ?? 'Grants trust';

/** A hint for the kinds the card cannot finish by itself, or `undefined`. */
export const harnessDialogHint = (dialog: HarnessDialog): string | undefined => {
  if (dialog.kind === 'sign-in') return 'Signing in finishes in the Console.';
  return undefined;
};
