/**
 * A CLAUDE CODE DIALOG, in the browser: the one call that answers it, and the plain words every surface uses for it.
 *
 * Claude's "New MCP server found" and its settings-error screen: the daemon reads them off the ferret's own pane and
 * answers one only while the pane still shows that very dialog. The dialog card and the surfaces beside it are built
 * from the helpers below, so they cannot describe one dialog several ways.
 */

import {
  type HarnessDialog,
  type HarnessDialogAnswerRequest,
  HarnessDialogAnswerRequestSchema,
  type HarnessDialogAnswerResult,
  HarnessDialogAnswerResultSchema,
  type HarnessDialogKind,
} from '../../contract/index.ts';
import { AnswerRefusal, type ClaudeCodeClient, refusedWith } from './client.ts';

/** The refusal code for a dialog the pane no longer shows. */
export const HARNESS_DIALOG_GONE = 'harness_dialog_gone';

/**
 * The dialog this answer was for is no longer on the ferret's screen. Nothing was typed; the page must re-read the
 * ferret.
 */
export class HarnessDialogGone extends AnswerRefusal {
  constructor(message: string) {
    super(409, message, HARNESS_DIALOG_GONE);
    this.name = 'HarnessDialogGone';
  }
}

/**
 * Answers the dialog on the ferret's pane. Governed as the Console is (`terminal.use`). `cleared: false` means the
 * keys landed and the same dialog is still up: the caller says so and never sends them again by itself.
 */
export const answerHarnessDialog = async (
  client: ClaudeCodeClient,
  ferret: string,
  answer: HarnessDialogAnswerRequest,
): Promise<HarnessDialogAnswerResult> => {
  let raw: unknown;
  try {
    raw = await client.call('POST /v1/ferrets/:ferretId/dialog', {
      params: { ferretId: ferret },
      body: HarnessDialogAnswerRequestSchema.parse(answer),
    });
  } catch (error) {
    if (refusedWith(error, 409, HARNESS_DIALOG_GONE)) throw new HarnessDialogGone(error.message);
    throw error;
  }
  const result = HarnessDialogAnswerResultSchema.parse(raw);
  if (result.dialogId !== answer.dialogId) throw new AnswerRefusal(502, 'daemon answered another dialog');
  return result;
};

/* ---------- plain words ---------------------------------------------------- */

/** The card's heading: "Hadi’s Claude Code is waiting: New MCP server found". */
export const harnessDialogSentence = (agent: string, dialog: HarnessDialog): string =>
  `${agent}’s Claude Code is waiting: ${dialog.title}`;

/** What choosing a trust-granting option does, in the app's words. */
const TRUST_NOTE: Readonly<Partial<Record<HarnessDialogKind, string>>> = {
  'mcp-servers': 'Lets this MCP server run',
};

export const harnessTrustNote = (dialog: HarnessDialog): string => TRUST_NOTE[dialog.kind] ?? 'Grants trust';
