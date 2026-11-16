import type { RunnerLook } from '../../../../contract/index.ts';
import { HarnessDialogSchema } from '../../../lib/protocol/session-dialog.ts';
import { PermissionRequestSchema } from '../../../lib/protocol/session-permission.ts';
import type { TurnPaneEvidence } from '../../../lib/session/peers/turn.ts';

/** The longest dialog words kept from a look (the state document's `turnPrompt` is a sentence, not a screen). */
const PROMPT_MAX = 300;

/**
 * A runner's look (`Runner.look`), as the turn decision reads it: today's `turnPaneEvidenceOf`, parsed at Ferrets'
 * boundary. The permission prompt and the harness dialog are parsed again through Ferrets' own schemas, and one that
 * does not parse is dropped (the `permission` flag still says a prompt is up), so a runner can never put a value into a
 * ferret's state document that its schema would refuse. Pure.
 */
export function turnPaneEvidenceOfLook(look: RunnerLook): TurnPaneEvidence {
  const request = look.request === undefined ? undefined : PermissionRequestSchema.safeParse(look.request);
  const dialog = look.dialog === undefined ? undefined : HarnessDialogSchema.safeParse(look.dialog);
  const prompt =
    typeof look.prompt === 'string' && look.prompt.trim() !== '' ? look.prompt.slice(0, PROMPT_MAX) : undefined;
  return {
    working: look.working === true,
    ...(look.spinnerOnly === true ? { spinnerOnly: true } : {}),
    atPrompt: look.atPrompt === true,
    permission: look.permission === true,
    ...(prompt === undefined ? {} : { prompt }),
    ...(request?.success === true ? { request: request.data } : {}),
    ...(dialog?.success === true ? { dialog: dialog.data } : {}),
    ...(typeof look.frame === 'string' ? { frame: look.frame } : {}),
  };
}
